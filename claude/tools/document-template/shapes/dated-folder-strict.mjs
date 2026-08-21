import * as datedFolder from './dated-folder.mjs';

export const shape = {
  ...datedFolder.shape,
  name: 'dated-folder-strict',
};

export const nameItem = datedFolder.nameItem;
export const validateName = datedFolder.validateName;
export const create = datedFolder.create;
export const tidy = datedFolder.tidy;

export function scan(ctx) {
  return datedFolder.scan(ctx).filter((item) => item.tidied || validateName(ctx, item.name).ok);
}
