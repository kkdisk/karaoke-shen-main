export function hasBackend(eelRef = globalThis.eel) {
  return typeof eelRef !== 'undefined' && eelRef !== null;
}

export async function rpc(name, ...args) {
  const eelRef = globalThis.eel;
  if (!hasBackend(eelRef)) {
    throw new Error('請以 Python 或桌面程式啟動，此操作需要本機後端');
  }
  const result = await eelRef[name](...args)();
  if (result && typeof result === 'object' && typeof result.error === 'string') {
    throw new Error(result.error);
  }
  return result;
}
