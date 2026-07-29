import { migrations_entries_01 } from "./migrations-entries-01.js";
import { migrations_entries_02 } from "./migrations-entries-02.js";

export const migrations = [...migrations_entries_01, ...migrations_entries_02] as const;
