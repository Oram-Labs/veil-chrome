<script lang="ts">
  // What the built-in engine did today, and the few things only the
  // extension has: using it, and deleting everything it keeps.
  import { app, count, SettingRow, Switch, toast } from 'veil-ui';
  import { engine } from './localBackend';

  let enabled = $state(true);
  let busy = $state(false);

  $effect(() => {
    void engine.enabled().then((v) => (enabled = v));
  });

  async function toggle(on: boolean) {
    enabled = on;
    await engine.setEnabled(enabled);
    toast.ok(enabled ? 'The built-in engine is used when the Veil app isn\'t running' : 'The built-in engine is off: messages wait for the Veil app');
  }

  async function forget() {
    if (!confirm('Forget the real values behind placeholders now?\n\nChats in this browser session will show their placeholders.')) return;
    try {
      await engine.forgetValues();
      toast.ok('Values forgotten');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function deleteEverything() {
    if (!confirm('Delete everything the built-in engine keeps in this browser?\n\nThis forgets the real values behind placeholders in your chats (they stay as placeholders), your settings and rules and the activity counts.')) return;
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
    <p class="sub">When the Veil app isn't running, the extension's built-in engine redacts emails, phone numbers, cards, IBANs, API keys, IP addresses and national ID numbers before claude.ai and chatgpt.com send them. It's free. It remembers the real values only while your browser is open: a chat from before the browser restarted shows its placeholders. Your own terms, attached files and names are redacted by the Veil app, which remembers values for good.</p>
  </div>

  <section class="card">
    <h2>Today</h2>
    <p>
      {count(app.status?.redacted_today ?? 0)} value(s) hidden in {count(app.status?.requests_today ?? 0)} request(s).
    </p>
  </section>

  <section class="card rows">
    <SettingRow
      label="Use the built-in engine"
      desc="When the Veil app isn't running, the extension redacts with its own engine. Turn off to make messages wait for the app instead."
      last
    >
      <Switch checked={enabled} label="Use the built-in engine" onchange={toggle} />
    </SettingRow>
  </section>

  <section class="card">
    <h2>Forget values now</h2>
    <p class="hint">The real values behind placeholders are kept in the browser's memory, never on disk, and forgotten when the browser closes. This forgets them now.</p>
    <button class="btn" type="button" onclick={forget}>Forget values now…</button>
  </section>

  <section class="card">
    <h2>Delete everything</h2>
    <p class="hint">Forgets what the built-in engine keeps in this browser: the values in memory, its settings, rules and activity counts.</p>
    <button class="btn" type="button" disabled={busy} onclick={deleteEverything}>Delete everything…</button>
  </section>
</div>

<style>
  h2 {
    margin: 0 0 6px;
  }
</style>
