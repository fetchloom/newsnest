export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
