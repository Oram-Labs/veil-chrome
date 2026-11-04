<script lang="ts">
  // What the built-in engine did today, and the few things only the
  // extension has: using it, and deleting everything it keeps.
  import { app, count, toast } from 'veil-ui';
  import { engine } from './localBackend';

  let enabled = $state(true);
  let busy = $state(false);

  $effect(() => {
    void engine.enabled().then((v) => (enabled = v));
  });

  async function toggle(e: Event & { currentTarget: HTMLInputElement }) {
    enabled = e.currentTarget.checked;
    await engine.setEnabled(enabled);
    toast.ok(enabled ? 'The built-in engine is used when the Veil app isn\'t running' : 'The built-in engine is off: messages wait for the Veil app');
  }

  async function deleteEverything() {
    if (!confirm('Delete everything the built-in engine keeps in this browser?\n\nThis forgets the real values behind placeholders in your chats (they stay as placeholders), your settings and rules, the activity log and your license key.')) return;
    busy = true;
    try {
      await engine.deleteEverything();
      location.reload();
    } catch (e) {
      toast.error((e as Error).message);
      busy = false;
    }
  }
</script>

<div class="page">
  <div>
    <h1>Dashboard</h1>
    <p class="sub">The extension's built-in engine redacts emails, phone numbers, cards, IBANs, API keys and your own terms before claude.ai and chatgpt.com send them. It reads text files; PDFs and name detection need the Veil app.</p>
  </div>

  <section class="card">
    <h2>Today</h2>
    <p>
      {count(app.status?.redacted_today ?? 0)} value(s) hidden in {count(app.status?.requests_today ?? 0)} request(s).
    </p>
  </section>

  <section class="card rows">
    <div class="row">
      <div>
        <h2>Use the built-in engine</h2>
        <p class="hint">When the Veil app isn't running, the extension redacts with its own engine. Turn off to make messages wait for the app instead.</p>
      </div>
      <input type="checkbox" role="switch" checked={enabled} onchange={toggle} aria-label="Use the built-in engine" />
    </div>
  </section>

  <section class="card">
    <h2>Delete everything</h2>
    <p class="hint">Forgets what the built-in engine keeps in this browser: the encrypted values, settings, rules, activity and the license key.</p>
    <button class="btn" type="button" disabled={busy} onclick={deleteEverything}>Delete everything…</button>
  </section>
</div>

<style>
  .row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: flex-start;
  }
  h2 {
    margin: 0 0 6px;
  }
</style>
