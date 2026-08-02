/** Recursive partial for translation dictionaries (leaves stay `string`). */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends string ? string : DeepPartial<T[K]>;
};

/** Dot-joined key paths of the dictionary, e.g. 'nav.dashboard'. */
export type DotKeys<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : DotKeys<T[K], `${Prefix}${K}.`>;
}[keyof T & string];
