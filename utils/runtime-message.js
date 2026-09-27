let contextInvalidated = false;

export function runtimeAvailable() {
  if (contextInvalidated) return false;
  try { return !!chrome.runtime?.id; }
  catch { contextInvalidated = true; return false; }
}

export function sendRuntimeMessage(message) {
  if (!runtimeAvailable()) return Promise.resolve(null);
  try {
    return chrome.runtime.sendMessage(message).catch(error => {
      if (String(error?.message || error).includes('Extension context invalidated')) {
        contextInvalidated = true;
        return null;
      }
      throw error;
    });
  } catch (error) {
    if (String(error?.message || error).includes('Extension context invalidated')) {
      contextInvalidated = true;
      return Promise.resolve(null);
    }
    return Promise.reject(error);
  }
}
