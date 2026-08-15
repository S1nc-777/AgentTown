import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve
} from "node:path";
import type {
  CompanyDefinition,
  GitTaskSubmission,
  ReviewPackageRecord,
  ValidationRunRecord
} from "@agenttown/runtime-contract";
import {
  CoreStore,
  type NewEvent
} from "../storage/core-store.js";
import type {
  AuthoritativeValidation,
  ValidatedSubmission
} from "./submission-validator.js";
import { SubmissionValidator } from "./submission-validator.js";

interface DirectoryIdentity {
  path: string;
  realPath: string;
  device: number;
  inode: number;
}

interface ManifestFile {
  sha256: string;
  size: number;
}

interface EvidenceManifest {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  employeeId: string;
  revision: number;
  baseCommit: string;
  headCommit: string;
  commits: string[];
  generatedAt: string;
  files: Record<string, ManifestFile>;
  totalFiles: number;
  totalBytes: number;
}

export interface EvidencePackageInput extends ValidatedSubmission {
  submission: GitTaskSubmission;
  revision: number;
  generatedAt?: string;
}

export interface EvidencePackageBuilderOptions {
  store: CoreStore;
  companyId: string;
  actorId?: string;
}

export interface EvidencePackageBuilderDependencies {
  beforePublish?: () => Promise<void>;
  afterPublish?: () => Promise<void>;
}

const injectedDependencies = new WeakMap<
  EvidencePackageBuilder,
  EvidencePackageBuilderDependencies
>();

export function createInjectedEvidencePackageBuilder(
  options: EvidencePackageBuilderOptions,
  dependencies: EvidencePackageBuilderDependencies
): EvidencePackageBuilder {
  const builder = new EvidencePackageBuilder(options);
  injectedDependencies.set(builder, dependencies);
  return builder;
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function pathKey(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[a-z][a-z0-9_-]*$/u.test(value)) {
    throw new TypeError(`${label} must be a safe identifier`);
  }
}

/**
 * Workspace identities are composite keys produced by the WorkspaceManager
 * (`<runId>:task:<employeeId>:<taskId>` or `<runId>:candidate:<attemptId>`),
 * so they allow colon-separated safe segments. The identity is an opaque
 * durable key and is never used as a filesystem path component.
 */
function assertWorkspaceIdentifier(value: string, label: string): void {
  if (
    value.length === 0
    || value.length > 512
    || !/^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*)*$/u.test(value)
  ) {
    throw new TypeError(`${label} must be a safe workspace identifier`);
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  }
  return value;
}

function stableJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(stableValue(value), null, 2)}\n`, "utf8");
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameRecord(left: ReviewPackageRecord, right: ReviewPackageRecord): boolean {
  return left.runId === right.runId
    && left.taskId === right.taskId
    && left.revision === right.revision
    && pathKey(left.manifestPath) === pathKey(right.manifestPath)
    && left.manifestHash === right.manifestHash
    && left.totalBytes === right.totalBytes
    && left.status === right.status;
}

function sameValidation(left: ValidationRunRecord, right: ValidationRunRecord): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

async function inspectDirectory(path: string): Promise<DirectoryIdentity> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("tampered: package path is not an ordinary directory");
  }
  return {
    path: resolve(path),
    realPath: await realpath(path),
    device: metadata.dev,
    inode: metadata.ino
  };
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return pathKey(left.path) === pathKey(right.path)
    && pathKey(left.realPath) === pathKey(right.realPath)
    && left.device === right.device
    && left.inode === right.inode;
}

function sameObjectIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function normalizeLf(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

async function assertSafeTree(root: string, target: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (!isWithin(resolvedRoot, resolvedTarget)) {
    throw new Error("tampered: review path escaped project root");
  }
  const rootMetadata = await lstat(resolvedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("tampered: project root is redirected");
  }
  const rootReal = await realpath(resolvedRoot);
  let current = resolvedRoot;
  for (const segment of relative(resolvedRoot, resolvedTarget).split(/[\\/]/u)) {
    if (segment.length === 0) continue;
    current = resolve(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("tampered: review path contains a redirect or non-directory");
    }
    if (!isWithin(rootReal, await realpath(current))) {
      throw new Error("tampered: review path contains a reparse escape");
    }
  }
}

async function makeSafeDirectory(root: string, target: string): Promise<DirectoryIdentity> {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (!isWithin(resolvedRoot, resolvedTarget)) {
    throw new Error("review path escaped project root");
  }
  let current = resolvedRoot;
  for (const segment of relative(resolvedRoot, resolvedTarget).split(/[\\/]/u)) {
    if (segment.length === 0) continue;
    current = resolve(current, segment);
    await mkdir(current).catch((error: unknown) => {
      if (!isMissing(error)
        && (!(error instanceof Error)
          || !("code" in error)
          || (error as NodeJS.ErrnoException).code !== "EEXIST")) {
        throw error;
      }
    });
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("review path contains a redirect or non-directory");
    }
  }
  await assertSafeTree(resolvedRoot, resolvedTarget);
  return await inspectDirectory(resolvedTarget);
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close();
  }
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function safeManifestPath(path: string): boolean {
  if (path.length === 0 || path.includes("\\") || path.startsWith("/")
    || path.includes("\0")) return false;
  const segments = path.split("/");
  return segments.every((segment) =>
    segment.length > 0 && segment !== "." && segment !== "..");
}

async function ownedCleanup(
  path: string,
  identity: DirectoryIdentity
): Promise<void> {
  let current;
  try {
    current = await inspectDirectory(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!sameDirectory(identity, current)) {
    throw new Error("refusing to clean a temporary directory whose identity changed");
  }
  await rm(path, { recursive: true, force: false });
}

async function ownedFileCleanup(
  path: string,
  expected: { device: number; inode: number }
): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || metadata.dev !== expected.device || metadata.ino !== expected.inode) {
    throw new Error("refusing to clean a publish reservation whose identity changed");
  }
  await unlink(path);
}

function summaryMarkdown(input: EvidencePackageInput): Buffer {
  const risks = input.knownRisks.length === 0
    ? "- None declared."
    : input.knownRisks.map((risk) => `- ${normalizeLf(risk)}`).join("\n");
  const warnings = input.warnings.length === 0
    ? "- None."
    : input.warnings.map((warning) =>
      `- Patch is ${warning.actualBytes} bytes; warning threshold is ${warning.warningBytes} bytes.`)
      .join("\n");
  return Buffer.from(
    `# Change Summary\n\n${normalizeLf(input.changeSummary).trim()}\n\n`
    + `## Known Risks\n\n${risks}\n\n`
    + `## Evidence Warnings\n\n${warnings}\n`,
    "utf8"
  );
}

export class EvidencePackageBuilder {
  readonly #store: CoreStore;
  readonly #companyId: string;
  readonly #actorId: string;

  constructor(options: EvidencePackageBuilderOptions) {
    this.#store = options.store;
    this.#companyId = options.companyId;
    this.#actorId = options.actorId ?? "core";
  }

  async create(input: EvidencePackageInput): Promise<ReviewPackageRecord> {
    assertIdentifier(input.runId, "run id");
    assertIdentifier(input.taskId, "task id");
    assertWorkspaceIdentifier(input.workspaceId, "workspace id");
    assertIdentifier(input.employeeId, "employee id");
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
      throw new TypeError("review revision must be a positive integer");
    }
    const run = this.#store.getGitRun(input.runId);
    const workspace = this.#store.getGitWorkspace(input.workspaceId);
    if (run === null || run.companyId !== this.#companyId || run.status !== "active") {
      throw new Error("review package company ownership does not match run");
    }
    if (workspace === null || workspace.runId !== input.runId
      || workspace.taskId !== input.taskId || workspace.employeeId !== input.employeeId
      || workspace.kind !== "task" || workspace.status !== "active"
      || workspace.branchRef !== input.branchRef
      || workspace.baseCommit !== input.baseCommit
      || workspace.headCommit !== input.headCommit) {
      throw new Error("review package input does not match an active registered workspace");
    }
    const task = this.#store.getTask(this.#companyId, input.taskId);
    if (task === null || task.ownerEmployeeId !== workspace.employeeId
      || (task.status !== "running" && task.status !== "review")) {
      throw new Error("review package task owner or status is not authoritative");
    }
    const company = this.#store.getCompany(this.#companyId);
    if (
      company === null
      || (company.status !== "active" && company.status !== "running")
    ) {
      throw new Error("review package company is not active");
    }
    const definition = JSON.parse(company.definitionJson) as CompanyDefinition;
    const actualInputPatchBytes = Buffer.byteLength(input.patch, "utf8");
    if (input.patchBytes !== actualInputPatchBytes
      || !Number.isSafeInteger(definition.evidence?.diffHardLimitBytes)
      || actualInputPatchBytes > definition.evidence.diffHardLimitBytes) {
      throw new Error("validated submission patch bytes exceed or mismatch the current hard limit");
    }
    const authoritative = await new SubmissionValidator({
      store: this.#store,
      companyId: this.#companyId
    }).validate(workspace, input.submission);
    this.#assertAuthoritativeInput(input, authoritative);
    input = {
      ...authoritative,
      revision: input.revision,
      ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt })
    };
    const projectRoot = resolve(run.projectRoot);
    const taskDirectory = resolve(
      projectRoot,
      ".agenttown",
      "runs",
      input.runId,
      "reviews",
      input.taskId
    );
    const destination = resolve(taskDirectory, String(input.revision));
    const manifestPath = resolve(destination, "manifest.json");
    await assertSafeTree(projectRoot, taskDirectory);
    const existingRecord = this.#store.getReviewPackage(
      input.runId,
      input.taskId,
      input.revision
    );
    let destinationExists = true;
    try {
      await inspectDirectory(destination);
    } catch (error) {
      if (isMissing(error)) destinationExists = false;
      else throw error;
    }
    if (destinationExists) {
      if (existingRecord === null
        || pathKey(existingRecord.manifestPath) !== pathKey(manifestPath)) {
        throw new Error("tampered: review package destination already exists");
      }
      await this.verify(existingRecord);
      return existingRecord;
    }
    if (existingRecord !== null) {
      throw new Error("tampered: durable review package directory is missing");
    }

    const taskIdentity = await makeSafeDirectory(projectRoot, taskDirectory);
    const tempDirectory = resolve(
      taskDirectory,
      `.${String(input.revision)}.${randomUUID()}.tmp`
    );
    await mkdir(tempDirectory, { recursive: false, mode: 0o700 });
    const tempIdentity = await inspectDirectory(tempDirectory);
    let cleanupIdentity: DirectoryIdentity | null = tempIdentity;
    let preserveOnFailure = false;
    try {
      const authoritative = await this.#authoritativeValidations(input, projectRoot);
      const validationDirectory = resolve(tempDirectory, "validation");
      await mkdir(validationDirectory, { recursive: false, mode: 0o700 });
      const files = new Map<string, Buffer>();
      files.set("task.json", stableJson({
        schemaVersion: 1,
        runId: input.runId,
        taskId: input.taskId,
        revision: input.revision,
        workspaceId: input.workspaceId,
        employeeId: input.employeeId,
        branchRef: input.branchRef,
        baseCommit: input.baseCommit,
        headCommit: input.headCommit,
        changeSummary: input.changeSummary,
        knownRisks: input.knownRisks,
        reportedResults: input.reportedResults,
        warnings: input.warnings
      }));
      files.set("commits.json", stableJson(input.commits));
      files.set("change-summary.md", summaryMarkdown(input));
      files.set("changes.patch", Buffer.from(
        input.patch.replaceAll("\r\n", "\n"),
        "utf8"
      ));
      files.set("files.json", stableJson(
        [...input.files].sort((left, right) => left.path.localeCompare(right.path, "en"))
      ));
      for (const validation of authoritative) {
        const commandId = validation.record.command.id;
        assertIdentifier(commandId, "validation command id");
        files.set(`validation/${commandId}.json`, stableJson(validation.record));
        files.set(`validation/${commandId}.log`, validation.log);
      }
      const orderedFiles = [...files.entries()]
        .sort(([left], [right]) => left.localeCompare(right, "en"));
      const manifestFiles: Record<string, ManifestFile> = {};
      let payloadBytes = 0;
      for (const [relativePath, bytes] of orderedFiles) {
        if (!safeManifestPath(relativePath)) {
          throw new Error(`unsafe evidence file path: ${relativePath}`);
        }
        const outputPath = resolve(tempDirectory, ...relativePath.split("/"));
        if (!isWithin(tempDirectory, outputPath)) {
          throw new Error(`evidence file escaped package: ${relativePath}`);
        }
        await writeExclusive(outputPath, bytes);
        manifestFiles[relativePath] = {
          sha256: sha256(bytes),
          size: bytes.length
        };
        payloadBytes += bytes.length;
      }
      await syncDirectory(validationDirectory);
      const generatedAt = input.generatedAt ?? new Date().toISOString();
      if (!Number.isFinite(Date.parse(generatedAt))) {
        throw new TypeError("generatedAt must be an ISO timestamp");
      }
      const manifest: EvidenceManifest = {
        schemaVersion: 1,
        runId: input.runId,
        taskId: input.taskId,
        employeeId: input.employeeId,
        revision: input.revision,
        baseCommit: input.baseCommit,
        headCommit: input.headCommit,
        commits: input.commits.map(({ id }) => id),
        generatedAt,
        files: manifestFiles,
        totalFiles: orderedFiles.length,
        totalBytes: payloadBytes
      };
      const manifestBytes = stableJson(manifest);
      const tempManifestPath = resolve(tempDirectory, "manifest.json");
      await writeExclusive(tempManifestPath, manifestBytes);
      await syncDirectory(tempDirectory);
      const record: ReviewPackageRecord = {
        runId: input.runId,
        taskId: input.taskId,
        revision: input.revision,
        manifestPath,
        manifestHash: sha256(manifestBytes),
        totalBytes: payloadBytes + manifestBytes.length,
        status: "created"
      };
      await this.#verifyDirectory(tempDirectory, {
        ...record,
        manifestPath: tempManifestPath
      });
      const reservationPath = resolve(
        taskDirectory,
        `.${String(input.revision)}.publish.lock`
      );
      const reservation = await open(reservationPath, "wx", 0o600);
      let reservationIdentity: { device: number; inode: number } | null = null;
      try {
        await reservation.writeFile(`${randomUUID()}\n`, "utf8");
        await reservation.sync();
        const reservationMetadata = await lstat(reservationPath);
        reservationIdentity = {
          device: reservationMetadata.dev,
          inode: reservationMetadata.ino
        };
        await injectedDependencies.get(this)?.beforePublish?.();
        if (!sameDirectory(taskIdentity, await inspectDirectory(taskDirectory))) {
          throw new Error("tampered: review task directory identity changed");
        }
        try {
          await lstat(destination);
          throw new Error("tampered: review package destination appeared during creation");
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        await rename(tempDirectory, destination);
        await injectedDependencies.get(this)?.afterPublish?.();
        const publishedIdentity = await inspectDirectory(destination);
        if (!sameObjectIdentity(tempIdentity, publishedIdentity)) {
          throw new Error("tampered: published review directory identity changed");
        }
        cleanupIdentity = publishedIdentity;
      } finally {
        await reservation.close();
        if (reservationIdentity !== null) {
          await ownedFileCleanup(reservationPath, reservationIdentity);
        }
      }
      await syncDirectory(taskDirectory);
      if (!sameDirectory(taskIdentity, await inspectDirectory(taskDirectory))) {
        throw new Error("tampered: review task directory identity changed after rename");
      }
      await this.#verifyDirectory(destination, record);
      const event: NewEvent = {
        id: randomUUID(),
        type: "review.package.created",
        actorId: this.#actorId,
        taskId: input.taskId,
        causationEventId: null,
        payload: {
          runId: input.runId,
          taskId: input.taskId,
          revision: input.revision,
          manifestPath,
          manifestHash: record.manifestHash,
          totalBytes: record.totalBytes
        }
      };
      try {
        this.#store.commitReviewPackageCreation({
          reviewPackage: record,
          event
        });
      } catch (error) {
        preserveOnFailure = true;
        try {
          if (cleanupIdentity !== null
            && sameDirectory(cleanupIdentity, await inspectDirectory(destination))
            && sameDirectory(taskIdentity, await inspectDirectory(taskDirectory))) {
            await rename(destination, tempDirectory);
            cleanupIdentity = await inspectDirectory(tempDirectory);
          }
        } catch {
          // Preserve whichever verified directory remains for operator recovery.
        }
        throw error;
      }
      cleanupIdentity = null;
      return record;
    } catch (error) {
      if (cleanupIdentity !== null && !preserveOnFailure) {
        const cleanupPath = pathKey(cleanupIdentity.path) === pathKey(destination)
          ? destination
          : tempDirectory;
        await ownedCleanup(cleanupPath, cleanupIdentity).catch(() => undefined);
      }
      throw error;
    }
  }

  #assertAuthoritativeInput(
    input: EvidencePackageInput,
    authoritative: ValidatedSubmission
  ): void {
    const scalarMatch = input.schemaVersion === authoritative.schemaVersion
      && input.runId === authoritative.runId
      && input.taskId === authoritative.taskId
      && input.workspaceId === authoritative.workspaceId
      && input.employeeId === authoritative.employeeId
      && input.branchRef === authoritative.branchRef
      && input.baseCommit === authoritative.baseCommit
      && input.headCommit === authoritative.headCommit
      && input.patch === authoritative.patch
      && input.patchBytes === authoritative.patchBytes
      && input.changeSummary === authoritative.changeSummary;
    const structuredMatch = exactJson(input.submission, authoritative.submission)
      && exactJson(input.commits, authoritative.commits)
      && exactJson(input.files, authoritative.files)
      && exactJson(input.warnings, authoritative.warnings)
      && exactJson(input.knownRisks, authoritative.knownRisks)
      && exactJson(input.reportedResults, authoritative.reportedResults)
      && input.validations.length === authoritative.validations.length
      && input.validations.every((validation, index) => {
        const expected = authoritative.validations[index];
        return expected !== undefined
          && exactJson(validation.record, expected.record)
          && validation.log.equals(expected.log);
      });
    if (!scalarMatch || !structuredMatch) {
      throw new Error("validated submission does not match authoritative Git and CoreStore facts");
    }
  }

  async verify(record: ReviewPackageRecord): Promise<ReviewPackageRecord> {
    const run = this.#store.getGitRun(record.runId);
    if (run === null || run.companyId !== this.#companyId) {
      throw new Error("tampered: review package does not belong to this company");
    }
    const expectedManifest = resolve(
      run.projectRoot,
      ".agenttown",
      "runs",
      record.runId,
      "reviews",
      record.taskId,
      String(record.revision),
      "manifest.json"
    );
    if (pathKey(record.manifestPath) !== pathKey(expectedManifest)) {
      throw new Error("tampered: review manifest path does not match its identity");
    }
    const stored = this.#store.getReviewPackage(
      record.runId,
      record.taskId,
      record.revision
    );
    if (stored === null || !sameRecord(stored, record)) {
      throw new Error("tampered: review record is absent from or differs from durable facts");
    }
    await assertSafeTree(resolve(run.projectRoot), resolve(record.manifestPath, ".."));
    await this.#verifyDirectory(resolve(record.manifestPath, ".."), record);
    return record;
  }

  async #authoritativeValidations(
    input: EvidencePackageInput,
    projectRoot: string
  ): Promise<AuthoritativeValidation[]> {
    const expectedDirectory = resolve(
      projectRoot,
      ".agenttown",
      "runs",
      input.runId,
      "validation"
    );
    const seen = new Set<string>();
    const results: AuthoritativeValidation[] = [];
    for (const candidate of input.validations) {
      const commandId = candidate.record.command.id;
      if (seen.has(commandId)) throw new Error(`duplicate validation evidence: ${commandId}`);
      seen.add(commandId);
      const record = this.#store.getValidationRun(candidate.record.validationId);
      if (record === null || !sameValidation(record, candidate.record)
        || record.runId !== input.runId || record.taskId !== input.taskId
        || record.workspaceId !== input.workspaceId || record.outcome !== "passed") {
        throw new Error(`authoritative validation record does not match: ${commandId}`);
      }
      const logPath = resolve(record.logPath);
      if (pathKey(resolve(logPath, "..")) !== pathKey(expectedDirectory)) {
        throw new Error(`validation log escaped evidence directory: ${commandId}`);
      }
      await assertSafeTree(projectRoot, expectedDirectory);
      const directoryIdentity = await inspectDirectory(expectedDirectory);
      const metadata = await lstat(logPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`validation log is tampered: ${commandId}`);
      }
      const log = await readFile(logPath);
      if (!sameDirectory(
        directoryIdentity,
        await inspectDirectory(expectedDirectory)
      )) {
        throw new Error(`validation log directory identity changed: ${commandId}`);
      }
      if (sha256(log) !== record.logHash || !log.equals(candidate.log)) {
        throw new Error(`validation log hash is tampered: ${commandId}`);
      }
      results.push({ record, log });
    }
    results.sort((left, right) =>
      left.record.command.id.localeCompare(right.record.command.id, "en"));
    return results;
  }

  async #verifyDirectory(
    directory: string,
    record: ReviewPackageRecord
  ): Promise<void> {
    const identity = await inspectDirectory(directory);
    const manifestPath = resolve(directory, "manifest.json");
    const manifestMetadata = await lstat(manifestPath);
    if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
      throw new Error("tampered: manifest is not an ordinary file");
    }
    const manifestBytes = await readFile(manifestPath);
    if (sha256(manifestBytes) !== record.manifestHash) {
      throw new Error("tampered: manifest hash changed");
    }
    let manifest: EvidenceManifest;
    try {
      manifest = JSON.parse(manifestBytes.toString("utf8")) as EvidenceManifest;
    } catch {
      throw new Error("tampered: manifest is not valid JSON");
    }
    if (manifest.schemaVersion !== 1
      || manifest.runId !== record.runId
      || manifest.taskId !== record.taskId
      || manifest.revision !== record.revision
      || manifest.totalFiles !== Object.keys(manifest.files).length) {
      throw new Error("tampered: manifest identity or totals changed");
    }
    const expectedFiles = new Set(["manifest.json", "validation"]);
    let payloadBytes = 0;
    for (const [relativePath, expected] of Object.entries(manifest.files)) {
      if (!safeManifestPath(relativePath)
        || !Number.isSafeInteger(expected.size) || expected.size < 0
        || !/^[0-9a-f]{64}$/u.test(expected.sha256)) {
        throw new Error("tampered: manifest contains an unsafe file entry");
      }
      expectedFiles.add(relativePath.split("/")[0]!);
      const filePath = resolve(directory, ...relativePath.split("/"));
      if (!isWithin(directory, filePath)) {
        throw new Error("tampered: manifest file escaped package");
      }
      const metadata = await lstat(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()
        || metadata.size !== expected.size) {
        throw new Error(`tampered: evidence file metadata changed: ${relativePath}`);
      }
      const bytes = await readFile(filePath);
      if (sha256(bytes) !== expected.sha256) {
        throw new Error(`tampered: evidence file hash changed: ${relativePath}`);
      }
      payloadBytes += bytes.length;
    }
    if (payloadBytes !== manifest.totalBytes
      || record.totalBytes !== payloadBytes + manifestBytes.length) {
      throw new Error("tampered: evidence package byte totals changed");
    }
    const rootNames = (await readdir(directory)).sort();
    if (rootNames.length !== expectedFiles.size
      || rootNames.some((name) => !expectedFiles.has(name))) {
      throw new Error("tampered: evidence package path set changed");
    }
    const validationDirectory = resolve(directory, "validation");
    const validationIdentity = await inspectDirectory(validationDirectory);
    const expectedValidation = Object.keys(manifest.files)
      .filter((path) => path.startsWith("validation/"))
      .map((path) => path.slice("validation/".length))
      .sort();
    const actualValidation = (await readdir(validationDirectory)).sort();
    if (actualValidation.length !== expectedValidation.length
      || actualValidation.some((name, index) => name !== expectedValidation[index])) {
      throw new Error("tampered: validation evidence path set changed");
    }
    if (!sameDirectory(identity, await inspectDirectory(directory))
      || !sameDirectory(validationIdentity, await inspectDirectory(validationDirectory))) {
      throw new Error("tampered: evidence directory identity changed during verification");
    }
  }
}
