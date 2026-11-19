import { pickModelFiles } from '../actions';

export const openAssemblyDialog = () => pickModelFiles((files) => import('./assembly-import').then((m) => m.importAssembly([...files], 'Assembly')));
