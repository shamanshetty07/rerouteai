export type Station = {
  /** Stable unique identifier; what the app keys selections on. */
  id: string;
  name: string;
  /** Official station code, when the data source has one. */
  code?: string;
  city: string;
};
