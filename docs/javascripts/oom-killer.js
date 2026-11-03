document.addEventListener("DOMContentLoaded", () => {
  const container = document.getElementById("oom-game");
  if (!container) return; // Only present on the OOM-killer playground page.

  const TOTAL_MEMORY = 100;

  // Baseline processes present when the page loads, so the gauge isn't empty.
  const STARTING_PROCESSES = [
    { name: "Window Manager", used: 4 },
    { name: "Audio Daemon", used: 2 },
    { name: "System Service", used: 5 },
  ];

  // Pool of processes a click can spawn. Bigger footprint = more likely to
  // end up as the eventual victim, same as it would be for real.
  const SPAWNABLE = [
    { name: "Browser Tab: 47 open Reddit posts", used: 14 },
    { name: "Video Call", used: 11 },
    { name: "IDE Indexing the Whole Repo", used: 16 },
    { name: "Docker Container", used: 9 },
    { name: "Photo Editor", used: 13 },
    { name: "Music Player", used: 3 },
    { name: "Background Update Service", used: 6 },
    { name: "Chat App", used: 5 },
    { name: "Game Client", used: 15 },
    { name: "Yet Another Browser Tab", used: 8 },
  ];

  let processes = [];
  let idCounter = 0;
  let killing = false;

  function totalUsed() {
    return processes.reduce((sum, p) => sum + (p.alive ? p.used : 0), 0);
  }

  function reset() {
    processes = STARTING_PROCESSES.map((p) => ({ ...p, id: idCounter++, alive: true }));
    killing = false;
    render();
  }

  function spawnProcess() {
    if (killing) return;
    const template = SPAWNABLE[Math.floor(Math.random() * SPAWNABLE.length)];
    processes.push({ ...template, id: idCounter++, alive: true });
    render();
    // Keep the newest process visible inside the scrollable list, without
    // moving the page itself.
    const list = container.querySelector(".oom-procs");
    if (list) list.scrollTop = list.scrollHeight;
    if (totalUsed() > TOTAL_MEMORY) {
      setTimeout(runOomKiller, 400);
    }
  }

  function runOomKiller() {
    killing = true;
    render();

    const candidates = processes.filter((p) => p.alive);
    const victim = candidates.reduce((biggest, p) => (p.used > biggest.used ? p : biggest), candidates[0]);

    setTimeout(() => {
      victim.alive = false;
      victim.justKilled = true;
      killing = false;
      render(victim);
      const row = container.querySelector(`[data-proc-id="${victim.id}"]`);
      if (row) row.scrollIntoView({ block: "nearest" });
    }, 900);
  }

  function pct(n) {
    return Math.min(100, Math.round((n / TOTAL_MEMORY) * 100));
  }

  function gaugeClass(used) {
    const p = pct(used);
    if (p >= 85) return "oom-gauge-fill oom-gauge-red";
    if (p >= 60) return "oom-gauge-fill oom-gauge-yellow";
    return "oom-gauge-fill oom-gauge-green";
  }

  function render(justKilledVictim) {
    const used = totalUsed();

    const processRows = processes
      .map((p) => {
        const dead = !p.alive;
        return `
          <div class="oom-proc ${dead ? "oom-proc-dead" : ""} ${killing && p.alive ? "oom-proc-scanning" : ""}" data-proc-id="${p.id}">
            <span class="oom-proc-name">${dead ? "\u{1F480} " : ""}${p.name}</span>
            <div class="oom-proc-bar-track">
              <div class="oom-proc-bar-fill" style="width:${pct(p.used)}%"></div>
            </div>
          </div>`;
      })
      .join("");

    const explanation = justKilledVictim
      ? `<div class="oom-explain">
           <p><strong>${justKilledVictim.name}</strong> was killed — at ${justKilledVictim.used} memory
           units, it was using more than anything else still running out of the ${used} total.
           That's <a href="../../mm/oom/#how-oom-selects-a-victim">how the real OOM killer picks a victim</a>
           too: memory footprint is the single biggest factor in the actual
           <a href="../../mm/oom/#oom-score-components">scoring</a>, not chance.</p>
           <p>On a real machine, this process would have had a fighting chance — you can
           <a href="../../mm/oom/#controlling-oom-behavior">protect a specific process</a> with
           <code>oom_score_adj</code> so it's (almost) never picked, or check
           <code>/proc/$PID/oom_score</code> right now to see where your own processes rank.</p>
         </div>`
      : "";

    container.innerHTML = `
      <div class="oom-gauge-label">System memory: ${pct(used)}%</div>
      <div class="oom-gauge-track">
        <div class="${gaugeClass(used)}" style="width:${pct(used)}%"></div>
      </div>
      <div class="oom-controls">
        <button id="oom-spawn-btn" class="oom-btn oom-btn-primary" ${killing ? "disabled" : ""}>
          Open another tab
        </button>
        <button id="oom-reset-btn" class="oom-btn">Reset</button>
      </div>
      <div class="oom-procs">${processRows}</div>
      ${explanation}
      <style>
        #oom-game { max-width: 640px; margin: 2rem auto; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        .oom-gauge-label { font-weight: 600; margin-bottom: 0.4rem; }
        .oom-gauge-track { height: 22px; border-radius: 11px; background: #e9ecef; overflow: hidden; margin-bottom: 1.2rem; }
        .oom-gauge-fill { height: 100%; transition: width 0.3s ease, background-color 0.3s ease; }
        .oom-gauge-green { background: #2ecc71; }
        .oom-gauge-yellow { background: #f1c40f; }
        .oom-gauge-red { background: #e74c3c; }
        .oom-procs { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; max-height: 340px; overflow-y: auto; padding-right: 0.25rem; }
        .oom-proc { display: flex; align-items: center; gap: 0.75rem; padding: 0.4rem 0.6rem; border-radius: 6px; background: #f8f9fa; transition: opacity 0.6s ease, transform 0.6s ease; }
        .oom-proc-name { flex: 0 0 220px; font-size: 0.9rem; }
        .oom-proc-bar-track { flex: 1; height: 10px; border-radius: 5px; background: #dee2e6; overflow: hidden; }
        .oom-proc-bar-fill { height: 100%; background: #007bff; transition: width 0.3s ease; }
        .oom-proc-scanning { animation: oom-pulse 0.4s ease-in-out infinite alternate; }
        .oom-proc-dead { opacity: 0.35; transform: scale(0.98); }
        .oom-proc-dead .oom-proc-name { text-decoration: line-through; }
        @keyframes oom-pulse { from { background: #f8f9fa; } to { background: #ffe3e3; } }
        .oom-explain { background: #fff3cd; border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 1rem; font-size: 0.9rem; }
        .oom-controls { display: flex; gap: 0.6rem; }
        .oom-btn { padding: 0.6rem 1rem; border-radius: 6px; border: 1px solid #ccc; background: white; cursor: pointer; font-size: 0.9rem; }
        .oom-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .oom-btn-primary { background: #007bff; color: white; border-color: #007bff; }
      </style>
    `;

    document.getElementById("oom-spawn-btn").addEventListener("click", spawnProcess);
    document.getElementById("oom-reset-btn").addEventListener("click", reset);
  }

  reset();
});
