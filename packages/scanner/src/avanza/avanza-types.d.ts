// Minimal type stub for avanza npm package (v3 ships no .d.ts)
declare module 'avanza' {
  interface AuthOptions {
    username: string;
    password: string;
    totpSecret?: string;
  }

  interface SearchOptions {
    limit?: number;
  }

  class Avanza {
    authenticate(options: AuthOptions): Promise<void>;
    search(query: string, options?: SearchOptions): Promise<unknown>;
  }

  export default Avanza;
}
