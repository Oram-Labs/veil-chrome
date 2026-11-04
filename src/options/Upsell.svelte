<script lang="ts">
  // What the Veil app adds, shown while the built-in engine is the one
  // working. One button: get the app, or open it if it is installed. Hiding
  // the card keeps it hidden for 30 days; only that date is stored.
  import { onMount } from 'svelte';
  import { SITE } from '../popup/update';

  let { appMissing }: { appMissing: boolean } = $props();

  const HIDE_DAYS = 30;
  let visible = $state(false);
  let note = $state('');

  const features: { icon: string; title: string; desc: string }[] = [
    { icon: 'file', title: 'Attached documents', desc: 'PDFs and text files, redacted before upload' },
    { icon: 'user', title: 'Names of people and companies', desc: 'Detected on your computer' },
    { icon: 'book', title: 'Your own terms and patterns', desc: 'Clients, codenames, ticket IDs' },
    { icon: 'lock', title: 'Values remembered for good', desc: 'Encrypted vault, old chats stay readable' },
    { icon: 'desktop', title: 'Claude and ChatGPT desktop apps', desc: 'Protected, not only the browser' },
    { icon: 'terminal', title: 'Claude Code, SDKs and editors', desc: 'Through a local proxy for the APIs' }
  ];

  onMount(async () => {
    const { upsell } = await chrome.storage.local.get('upsell');
    visible = !((upsell as { hiddenUntil?: number } | undefined)?.hiddenUntil! > Date.now());
  });

  async function hide() {
    visible = false;
    await chrome.storage.local.set({ upsell: { hiddenUntil: Date.now() + HIDE_DAYS * 24 * 60 * 60 * 1000 } });
  }

  async function openApp() {
    note = '';
    const answer = await chrome.runtime.sendMessage({ op: 'open' });
    if (!answer?.ok) note = 'Open Veil from your Applications folder or Start menu.';
  }
</script>

{#if visible}
  <section class="card upsell" aria-labelledby="upsell-title">
    <div class="head">
      <div>
        <h2 id="upsell-title">Get more out of Veil with the app</h2>
        <p class="hint">The extension covers the basics. The Veil app for Mac, Windows and Linux adds:</p>
      </div>
      <button class="close" type="button" aria-label="Hide for 30 days" title="Hide for 30 days" onclick={hide}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
    <ul class="features">
      {#each features as f (f.title)}
        <li>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {#if f.icon === 'file'}<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" />
            {:else if f.icon === 'user'}<circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />
            {:else if f.icon === 'book'}<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" /><path d="M4 19V5M8 7h7" />
            {:else if f.icon === 'lock'}<rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
            {:else if f.icon === 'desktop'}<rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" />
            {:else}<rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M12 15h5" />
            {/if}
          </svg>
          <div>
            <div class="title">{f.title}</div>
            <div class="desc">{f.desc}</div>
          </div>
        </li>
      {/each}
    </ul>
    <div class="actions">
      {#if appMissing}
        <a class="btn primary" href="{SITE}/#download" target="_blank" rel="noreferrer">Get the Veil app</a>
      {:else}
        <button class="btn primary" type="button" onclick={openApp}>Open Veil</button>
      {/if}
      <span class="hint">Everything stays on your computer.</span>
    </div>
    {#if note}<p class="hint">{note}</p>{/if}
  </section>
{/if}

<style>
  .head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }
  h2 {
    margin: 0 0 4px;
  }
  .close {
    border: 0;
    background: none;
    padding: 4px;
    color: var(--muted);
    cursor: pointer;
    border-radius: 6px;
  }
  .close:hover {
    background: var(--sunken);
  }
  .close svg {
    width: 16px;
    height: 16px;
  }
  svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .features {
    list-style: none;
    padding: 0;
    margin: 16px 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px 20px;
  }
  .features li {
    display: flex;
    gap: 10px;
  }
  .features li svg {
    flex: none;
    width: 18px;
    height: 18px;
    margin-top: 2px;
    color: var(--focus);
  }
  .title {
    font-weight: 600;
    font-size: 14px;
  }
  .desc {
    font-size: 13px;
    color: var(--muted);
  }
  .actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
  }
  .actions a {
    display: inline-flex;
    align-items: center;
    text-decoration: none;
  }
  @media (max-width: 560px) {
    .features {
      grid-template-columns: 1fr;
    }
  }
</style>
