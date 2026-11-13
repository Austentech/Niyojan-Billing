import postgres from "postgres";

/**
 * Minimal test-only query builder over postgres.js.
 *
 * Mirrors the small subset of the previous Supabase client API the test
 * suites used (from/select/eq/neq/like/is/order/limit/single/maybeSingle/
 * insert/update/delete/rpc, {data, error} results), so the integration
 * tests keep their exact call chains against the plain PostgreSQL harness.
 *
 *   * opsClient()  — connects as the table OWNER (test manipulation).
 *   * anonClient() — connects as the deliberately UNPRIVILEGED niyojan_anon
 *     role (created by the harness with zero table privileges) to prove the
 *     unprivileged database surface stays blocked — the successor to the
 *     Supabase-era RLS checks (the browser itself never holds DB credentials
 *     in this architecture).
 *
 * TEST TOOLING ONLY — never imported by application code.
 */

interface QueryResult<T> {
  data: T | null;
  error: { message: string; code: string } | null;
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

function assertIdent(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return name;
}

class Builder<T> {
  private filters: string[] = [];
  private params: unknown[] = [];
  private limitCount: number | null = null;
  private orderClause = "";
  private selectCols = "*";

  constructor(
    private sql: postgres.Sql,
    private table: string,
    private mode: "select" | "update" | "delete" | null = "select",
    private patch?: Record<string, unknown>,
  ) {}

  private filter(col: string, op: string, value: unknown, isNull = false): this {
    assertIdent(col);
    if (isNull) {
      this.filters.push(`${col} ${op}`);
    } else {
      this.params.push(value);
      this.filters.push(`${col} ${op} $${this.params.length}`);
    }
    return this;
  }

  select(cols = "*"): this {
    this.selectCols = cols;
    return this;
  }

  eq(col: string, value: unknown): this {
    return this.filter(col, "=", value);
  }
  neq(col: string, value: unknown): this {
    return this.filter(col, "<>", value);
  }
  like(col: string, pattern: string): this {
    return this.filter(col, "like", pattern);
  }
  ilike(col: string, pattern: string): this {
    return this.filter(col, "ilike", pattern);
  }
  is(col: string, value: null): this {
    return this.filter(col, value === null ? "is null" : "is not null", value, true);
  }
  order(col: string, options: { ascending?: boolean } = {}): this {
    assertIdent(col);
    this.orderClause = `order by ${col} ${options.ascending ? "asc" : "desc"}`;
    return this;
  }
  limit(n: number): this {
    this.limitCount = n;
    return this;
  }

  private whereClause(): string {
    return this.filters.length > 0 ? ` where ${this.filters.join(" and ")}` : "";
  }

  async maybeSingle(): Promise<QueryResult<T>> {
    try {
      const rows = await this.run<T[]>();
      return { data: (rows as T[])[0] ?? null, error: null };
    } catch (err) {
      const anyErr = err as { message?: string; code?: string };
      return { data: null, error: { message: anyErr?.message ?? "error", code: anyErr?.code ?? "ERROR" } };
    }
  }

  async single(): Promise<QueryResult<T>> {
    return this.maybeSingle();
  }

  /** Awaitable terminal: resolves to the {data, error} result shape. */
  async then<TResolve = QueryResult<T>, TReject = never>(
    resolve: (result: QueryResult<T>) => TResolve | PromiseLike<TResolve>,
    reject: (err: unknown) => TReject | PromiseLike<TReject>,
  ): Promise<TResolve | TReject> {
    try {
      const rows = await this.run<unknown[]>();
      const data = this.mode === "select" ? rows : null;
      return resolve({ data: data as T, error: null } as QueryResult<T>);
    } catch (err) {
      const anyErr = err as { message?: string; code?: string };
      return resolve({ data: null, error: { message: anyErr?.message ?? "error", code: anyErr?.code ?? "ERROR" } });
    }
  }

  private async run<R>(): Promise<R> {
    let query: string;
    if (this.mode === "select") {
      query = `select ${this.selectCols} from ${this.table}${this.whereClause()}`;
    } else if (this.mode === "update") {
      const sets = Object.entries(this.patch!).map(([col, value]) => {
        assertIdent(col);
        this.params.push(value);
        return `${col} = $${this.params.length}`;
      });
      query = `update ${this.table} set ${sets.join(", ")}${this.whereClause()}`;
    } else {
      query = `delete from ${this.table}${this.whereClause()}`;
    }
    if (this.orderClause) query += ` ${this.orderClause}`;
    if (this.limitCount !== null) query += ` limit ${this.limitCount}`;
    const rows = (await this.sql.unsafe(query, this.params)) as unknown as R;
    return rows;
  }
}

class InsertBuilder<T> {
  private returning = "*";

  constructor(
    private sql: postgres.Sql,
    private table: string,
    private values: Record<string, unknown>[],
  ) {}

  select(cols: string): this {
    this.returning = cols;
    return this;
  }

  async single(): Promise<QueryResult<T>> {
    try {
      const rows = await this.run<T[]>();
      return { data: (rows as T[])[0] ?? null, error: null };
    } catch (err) {
      const anyErr = err as { message?: string; code?: string };
      return { data: null, error: { message: anyErr?.message ?? "error", code: anyErr?.code ?? "ERROR" } };
    }
  }

  async then<TResolve = QueryResult<unknown>, TReject = never>(
    resolve: (result: QueryResult<unknown>) => TResolve | PromiseLike<TResolve>,
    reject: (err: unknown) => TReject | PromiseLike<TReject>,
  ): Promise<TResolve | TReject> {
    try {
      await this.run<unknown[]>();
      return resolve({ data: null, error: null });
    } catch (err) {
      const anyErr = err as { message?: string; code?: string };
      return resolve({ data: null, error: { message: anyErr?.message ?? "error", code: anyErr?.code ?? "ERROR" } });
    }
  }

  private async run<R>(): Promise<R> {
    const row = this.values[0]!;
    const cols = Object.keys(row).map(assertIdent);
    const params = cols.map((c) => row[c]);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const rows = (await this.sql.unsafe(
      `insert into ${this.table} (${cols.join(", ")}) values (${placeholders}) returning ${this.returning}`,
      params,
    )) as unknown as R;
    return rows;
  }
}

/** A client with the subset of the old query API used by the tests. */
function makeClient(connectionString: string) {
  const sql = postgres(connectionString, { max: 4, idle_timeout: 5, prepare: false });
  return {
    _sql: sql,
    from(table: string) {
      const safe = assertIdent(table);
      return {
        select: (cols = "*") => new Builder(sql, safe, "select").select(cols),
        update: (patch: Record<string, unknown>) => new Builder(sql, safe, "update", patch),
        delete: () => new Builder(sql, safe, "delete"),
        insert: (values: Record<string, unknown>) => new InsertBuilder(sql, safe, [values]),
      };
    },
    async rpc(fn: string, params: Record<string, unknown> = {}) {
      try {
        const args = Object.values(params);
        // Always bind at least one parameter: with zero bindings postgres.js
        // takes the simple-protocol path where server errors surface as a
        // fatal connection error instead of rejecting the query promise.
        const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
        const query =
          args.length > 0
            ? `select ${fn}(${placeholders}) as data`
            : `select ${fn}() as data where $1::bool is true`;
        const rows = await sql.unsafe(query, args.length > 0 ? args : [true]);
        return { data: rows[0]?.data ?? null, error: null };
      } catch (err) {
        const anyErr = err as { message?: string; code?: string };
        return { data: null, error: { message: anyErr?.message ?? "error", code: anyErr?.code ?? "ERROR" } };
      }
    },
    async end() {
      await sql.end({ timeout: 5 });
    },
  };
}

/** Owner-level manipulation client (the trusted test operator). */
export function opsClient() {
  const url = process.env.DATABASE_URL ?? "";
  return makeClient(url);
}

/** Unprivileged client — zero table privileges (the old "anon" boundary). */
export function anonClient() {
  const url = (process.env.DATABASE_URL ?? "").replace(/\/\/postgres:/, "//niyojan_anon:anon-pass@");
  return makeClient(url);
}

/** Error-shaped result for expected-failure assertions. */
export function asError(err: unknown): { message: string; code: string } {
  const anyErr = err as { message?: string; code?: string };
  return { message: anyErr?.message ?? "error", code: anyErr?.code ?? "ERROR" };
}
