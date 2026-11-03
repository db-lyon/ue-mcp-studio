/**
 * The ue-mcp account Studio acts as: a sign-in from the panel wins, otherwise
 * the account `ue-mcp login` cached. Chat, the Account tab and remote control
 * all read this one source, and hear when the account changes (a sign-in or
 * sign-out in the panel, or a new `ue-mcp login`) without a daemon restart.
 */

export interface RegistryAccount {
  login: string;
  token: string;
}

export interface PanelAccount {
  accountToken(): string | null;
  accountLogin(): string | null;
}

export class AccountSource {
  private registry: RegistryAccount | null = null;
  private last: string | null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly panel: PanelAccount,
    private readonly registryAccount: () => Promise<RegistryAccount | null>,
  ) {
    this.last = panel.accountToken();
  }

  /** The account token now, from what was last read of `ue-mcp login`. */
  current(): string | null {
    return this.panel.accountToken() ?? this.registry?.token ?? null;
  }

  /** The `ue-mcp login` account as last read, for showing where a sign-in came from. */
  registryLogin(): RegistryAccount | null {
    return this.registry;
  }

  /** Read `ue-mcp login` again; tells the listeners when the token changed. */
  async refresh(): Promise<void> {
    const next = await this.registryAccount().catch(() => null);
    this.registry = next ? { login: next.login, token: next.token } : null;
    this.changed();
  }

  /** The account token, after reading `ue-mcp login` again. */
  async token(): Promise<string | null> {
    await this.refresh();
    return this.current();
  }

  /** Call after the panel signs in or out: tells the listeners when the token changed. */
  changed(): void {
    const now = this.current();
    if (now === this.last) return;
    this.last = now;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
