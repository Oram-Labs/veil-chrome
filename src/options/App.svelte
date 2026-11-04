<script lang="ts">
  // The extension's settings: the Veil app's screens (veil-ui) over the
  // built-in engine, and what only the extension has to say. When the Veil
  // app is running, it holds the settings, and this page only points to it.
  import { onMount } from 'svelte';
  import {
    ActivityScreen,
    BehaviorScreen,
    GeneralScreen,
    PlaygroundScreen,
    RulesScreen,
    Shield,
    StatusBadge,
    Toasts,
    VaultScreen,
    app,
    start,
    type ScreenName
  } from 'veil-ui';
  import Dashboard from './Dashboard.svelte';
  import { localBackend } from './localBackend';

  const screens: { name: ScreenName; label: string }[] = [
    { name: 'dashboard', label: 'Dashboard' },
    { name: 'rules', label: 'Rules' },
    { name: 'behavior', label: 'Behavior' },
    { name: 'playground', label: 'Test playground' },
    { name: 'activity', label: 'Activity' },
    { name: 'vault', label: 'Vault and privacy' },
    { name: 'general', label: 'General' }
  ];

  let route = $state<ScreenName>('dashboard');
  /** The Veil app answered: its settings are the ones that count. */
  let appRunning = $state<boolean | null>(null);
  let opening = $state(false);
  let note = $state('');

  function fromHash(): ScreenName {
    const name = location.hash.replace(/^#\//, '') as ScreenName;
    return screens.some((s) => s.name === name) ? name : 'dashboard';
  }

  async function check() {
    const answer = await chrome.runtime.sendMessage({ op: 'status' });
    appRunning = answer?.ok === true && answer.result?.engine !== 'builtin';
  }

  async function openApp() {
    opening = true;
    note = '';
    const answer = await chrome.runtime.sendMessage({ op: 'open' });
    note = answer?.ok ? '' : 'Open Veil from your Applications folder or Start menu.';
    for (let i = 0; i < 20 && answer?.ok; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      await check();
      if (appRunning) break;
    }
    opening = false;
  }

  // The theme chosen in General.
  $effect(() => {
    const theme = app.config?.settings.app.theme ?? 'system';
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  });

  onMount(() => {
    route = fromHash();
    window.addEventListener('hashchange', () => (route = fromHash()));
    void check().then(() => {
      if (!appRunning) void start(localBackend);
    });
  });
</script>

{#if appRunning === null}
  <main class="plain"><p class="hint">Checking…</p></main>
{:else if appRunning}
  <main class="plain">
    <section class="card">
      <Shield />
      <h1>Veil</h1>
      <p>Your settings are in the Veil app, which is running. Open it to change them.</p>
      <p class="hint">This page holds the settings of the extension's built-in engine, which is used only when the app isn't running.</p>
      <button class="btn" type="button" onclick={() => chrome.runtime.sendMessage({ op: 'open' })}>Open Veil</button>
    </section>
  </main>
{:else if app.config && app.rules}
  <div class="shell">
    <nav aria-label="Settings sections">
      <div class="brand"><Shield /><span>Veil</span><span class="hint">built-in engine</span></div>
      {#each screens as s (s.name)}
        <a href="#/{s.name}" aria-current={route === s.name ? 'page' : undefined}>{s.label}</a>
      {/each}
      <div class="foot"><StatusBadge status={app.status} compact /></div>
    </nav>
    <main>
      <div class="content">
        {#if route === 'dashboard'}<Dashboard />
        {:else if route === 'rules'}<RulesScreen />
        {:else if route === 'behavior'}<BehaviorScreen />
        {:else if route === 'playground'}<PlaygroundScreen />
        {:else if route === 'activity'}<ActivityScreen />
        {:else if route === 'vault'}<VaultScreen />
        {:else if route === 'general'}<GeneralScreen />
        {/if}
      </div>
    </main>
  </div>
{:else}
  <main class="plain"><p class="hint">Loading…</p></main>
{/if}
<Toasts />
{#if note}<p class="hint note">{note}</p>{/if}
{#if opening}<p class="hint note">Opening Veil…</p>{/if}

<style>
  .shell {
    display: grid;
    grid-template-columns: 220px 1fr;
    min-height: 100vh;
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 16px 12px;
    background: var(--surface);
    border-right: 1px solid var(--line);
  }
  nav a {
    padding: 8px 10px;
    border-radius: 8px;
    color: var(--text);
    text-decoration: none;
  }
  nav a[aria-current='page'] {
    background: var(--accent-soft);
    font-weight: 600;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px 16px;
    font-weight: 600;
  }
  .brand .hint {
    font-weight: 400;
    font-size: 12px;
  }
  .foot {
    margin-top: auto;
    padding: 12px 10px 0;
  }
  main {
    min-width: 0;
  }
  .content {
    max-width: 900px;
    margin: 0 auto;
    padding: 24px;
  }
  .plain {
    max-width: 520px;
    margin: 12vh auto;
    padding: 0 16px;
  }
  .note {
    position: fixed;
    bottom: 12px;
    left: 16px;
  }
  @media (max-width: 720px) {
    .shell {
      grid-template-columns: 1fr;
    }
    nav {
      flex-direction: row;
      flex-wrap: wrap;
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }
    .brand,
    .foot {
      display: none;
    }
  }
</style>
