// node:fs, node:path y node:url: el servidor solo los usa para archivos locales,
// que en el navegador no existen.
export const mkdirSync = () => {};
export const rmSync = () => {};
export const readFile = async () => { throw new Error('sin sistema de archivos'); };
export const dirname = p => p.replace(/\/[^/]*$/, '');
export const extname = p => (p.match(/\.[^./]*$/) || [''])[0];
export const join = (...p) => p.join('/');
export const normalize = p => p;
export const sep = '/';
export const fileURLToPath = u => String(u ?? '');
