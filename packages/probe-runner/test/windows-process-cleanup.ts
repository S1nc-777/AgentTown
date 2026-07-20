export interface WindowsProcessIdentity {
  ProcessId: number;
  CreationDate: string;
  Name: string;
  CommandLine: string | null;
}

export interface RecordedProcessTree {
  parentPid: number;
  grandchildPid: number;
  nonce: string;
}

interface CleanupDependencies {
  queryIdentity(pid: number): Promise<WindowsProcessIdentity | undefined>;
  killTree(pid: number): Promise<void>;
}

function assertExpectedIdentity(
  actual: WindowsProcessIdentity,
  expectedPid: number,
  nonce: string
): void {
  if (actual.ProcessId !== expectedPid
    || actual.CreationDate.length === 0
    || actual.Name.toLowerCase() !== "node.exe"
    || actual.CommandLine?.includes(nonce) !== true) {
    throw new Error(`Refusing to taskkill PID ${expectedPid}: Win32_Process identity changed`);
  }
}

async function killVerifiedProcess(
  pid: number,
  nonce: string,
  dependencies: CleanupDependencies
): Promise<void> {
  const identity = await dependencies.queryIdentity(pid);
  if (!identity) return;
  assertExpectedIdentity(identity, pid, nonce);

  try {
    await dependencies.killTree(pid);
  } catch (error) {
    const remaining = await dependencies.queryIdentity(pid);
    if (!remaining) return;
    assertExpectedIdentity(remaining, pid, nonce);
    throw new Error(`Verified test process ${pid} survived taskkill`, { cause: error });
  }
}

export async function cleanupVerifiedProcessTree(
  tree: RecordedProcessTree,
  dependencies: CleanupDependencies
): Promise<void> {
  await killVerifiedProcess(tree.parentPid, tree.nonce, dependencies);
  await killVerifiedProcess(tree.grandchildPid, tree.nonce, dependencies);
}
