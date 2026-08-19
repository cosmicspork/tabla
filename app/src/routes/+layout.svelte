<script lang="ts">
  import '../app.css';

  let { children } = $props();
</script>

<div class="shell">
  <header>
    <a class="brand" href="/">tabla</a>
    <nav>
      <a href="/settings">Settings</a>
    </nav>
  </header>

  <main>
    {@render children()}
  </main>
</div>

<style>
  .shell {
    max-width: 34rem;
    margin: 0 auto;
    padding: 1rem 1rem 4rem;
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding-block: 0.75rem 1.5rem;
  }

  .brand {
    font-size: 1.35rem;
    font-weight: 650;
    letter-spacing: -0.02em;
    color: var(--fg);
    text-decoration: none;
  }

  nav a {
    font-size: 0.9rem;
    color: var(--fg-muted);
  }
</style>
