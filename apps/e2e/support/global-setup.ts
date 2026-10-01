import { reseed } from './data';

// Fresh demo data before the run (the API's webServer already migrated the database).
export default function globalSetup() {
  reseed();
}
