export const logger = {
  warn: (tag, ...args) => console.warn(`[HLS Cache Player] ${tag}:`, ...args),
  error: (tag, ...args) => console.error(`[HLS Cache Player] ${tag}:`, ...args),
};
