// Types for the one export tests use; the bridge itself is plain JS run by node.
export function peerAllowed(
  peer: string | undefined,
  gateway: string,
  ifaces?: Record<
    string,
    Array<{ family: string; address: string; netmask: string }> | undefined
  >,
): boolean;
