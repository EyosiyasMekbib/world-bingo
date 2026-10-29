/**
 * The staging simulator's "book": the page `start-session` points the
 * player's iframe at, standing in for IGCORE's sportsbook. Self-contained
 * (inline CSS and JS, no external assets, no framework) so the CSP below can
 * stay this tight. Every button posts to `book/action` on the same origin,
 * which signs and sends the matching IGCORE callback to our real callback
 * routes; the log pane shows what was sent and what our routes answered.
 */

/** Overrides Helmet for the book only: it must render inside the web app's iframe on another origin. */
export const BOOK_CSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors *"

/** Three fixed matches; odds are home / draw / away. */
const MATCHES = [
    { home: 'Addis Lions', away: 'Rift Eagles', odds: [1.85, 3.2, 4.1] },
    { home: 'Blue Nile', away: 'Highland Rovers', odds: [2.4, 3.0, 2.9] },
    { home: 'Awash United', away: 'Simien City', odds: [1.5, 3.8, 6.5] },
]

/** JSON for a <script> block: `<` escaped so no value can close the tag. */
function scriptJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c')
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; font: 14px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; background: #f6f7f9; color: #1d2330; }
h1 { font-size: 16px; margin: 0 0 4px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #5a6476; margin: 20px 0 8px; }
.note { color: #5a6476; font-size: 12px; margin: 0 0 12px; }
.banner { background: #fff4d6; border: 1px solid #f0c75e; border-radius: 6px; padding: 6px 10px; font-size: 12px; margin-bottom: 12px; }
.card { background: #fff; border: 1px solid #dde1e8; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
.match { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; justify-content: space-between; }
.odds { display: flex; gap: 6px; }
button { font: inherit; border: 1px solid #c3c9d4; background: #fff; border-radius: 6px; padding: 5px 10px; cursor: pointer; }
button:hover { background: #eef1f6; }
button:disabled { opacity: .45; cursor: default; }
button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
label { font-size: 13px; }
input { font: inherit; width: 90px; padding: 4px 6px; border: 1px solid #c3c9d4; border-radius: 6px; }
table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dde1e8; border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eef0f4; font-size: 13px; vertical-align: middle; }
td.actions { display: flex; flex-wrap: wrap; gap: 4px; }
.status-open { color: #1f6feb; } .status-settled, .status-cashed { color: #5a6476; }
#log { display: grid; gap: 6px; }
pre { margin: 0; background: #0f1420; color: #d6deeb; padding: 8px 10px; border-radius: 6px; font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
pre.bad { border-left: 4px solid #e5534b; } pre.good { border-left: 4px solid #3fb950; }
`

const SCRIPT = `
(function () {
    var CONFIG = JSON.parse(document.getElementById('config').textContent);
    var ACTION_URL = location.pathname.replace(/\\/book\\/?$/, '/book/action');
    var tickets = [];

    function round2(n) { return Math.round(n * 100) / 100; }
    function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
    function accepted(r) { return r && r.status === 200 && r.json && r.json.error === null; }
    function stake() { return round2(Number(document.getElementById('stake').value)); }
    function find(id) { for (var i = 0; i < tickets.length; i++) if (tickets[i].id === id) return tickets[i]; return null; }

    function log(op, data, good) {
        var pre = el('pre', op + '\\n' + JSON.stringify(data, null, 2), good ? 'good' : 'bad');
        var pane = document.getElementById('log');
        pane.insertBefore(pre, pane.firstChild);
    }

    // One action at a time: a double-clicked "Settle win" would otherwise send
    // two results under different transaction ids and pay the ticket twice.
    var busy = false;

    function act(payload) {
        if (busy) return Promise.resolve({});
        busy = true;
        payload.s = CONFIG.session;
        return fetch(ACTION_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(function (res) { return res.json().catch(function () { return { error: 'HTTP ' + res.status }; }); })
            .then(function (data) {
                var answers = Array.isArray(data.response) ? data.response : [data.response];
                log(payload.op, data, !data.error && answers.every(accepted));
                busy = false;
                return data;
            })
            .catch(function (err) { log(payload.op, { error: String(err) }, false); busy = false; return {}; });
    }

    function placeBet(label, odds) {
        var amount = stake();
        act({ op: 'bet', stake: amount, odds: odds }).then(function (data) {
            if (!accepted(data.response)) return;
            tickets.push({ id: data.sent.info.ticketId, label: label, stake: amount, odds: odds, status: 'open' });
            render();
        });
    }

    function settle(t, op) {
        act({ op: op, ticketId: t.id }).then(function (data) {
            if (accepted(data.response)) { t.status = 'settled'; render(); }
        });
    }

    function cashout(t, portionInput) {
        var portion = Number(portionInput.value);
        act({ op: 'cashout', ticketId: t.id, portion: portion }).then(function (data) {
            if (!accepted(data.response)) return;
            t.status = 'cashed';
            var next = data.sent.info.newTicket;
            if (next) tickets.push({ id: next.id, label: t.label + ' (remainder)', stake: round2(t.stake * (1 - portion)), odds: t.odds, status: 'open' });
            render();
        });
    }

    function rollbackSettlement(t) {
        act({ op: 'rollback-settlement', ticketId: t.id }).then(function (data) {
            if (accepted(data.response)) { t.status = 'open'; render(); }
        });
    }

    function render() {
        var body = document.getElementById('tickets');
        body.textContent = '';
        if (tickets.length === 0) {
            var empty = el('tr'); var td = el('td', 'No tickets yet. Pick odds above to place a bet.'); td.colSpan = 6; empty.appendChild(td); body.appendChild(empty);
            return;
        }
        tickets.forEach(function (t) {
            var tr = el('tr');
            tr.appendChild(el('td', '#' + t.id));
            tr.appendChild(el('td', t.label));
            tr.appendChild(el('td', String(t.stake)));
            tr.appendChild(el('td', String(t.odds)));
            tr.appendChild(el('td', t.status, 'status-' + t.status));
            var actions = el('td', null, 'actions');
            var open = t.status === 'open';
            var win = el('button', 'Settle win'); win.disabled = !open; win.onclick = function () { settle(t, 'settle-win'); };
            var lose = el('button', 'Settle lose'); lose.disabled = !open; lose.onclick = function () { settle(t, 'settle-lose'); };
            var portion = el('input'); portion.type = 'number'; portion.min = '0.01'; portion.max = '1'; portion.step = '0.05'; portion.value = '0.5'; portion.title = 'Portion to cash out (1 = all)'; portion.style.width = '64px'; portion.disabled = !open;
            var cash = el('button', 'Cash out'); cash.disabled = !open; cash.onclick = function () { cashout(t, portion); };
            var undo = el('button', 'Roll back settlement'); undo.disabled = t.status !== 'settled'; undo.onclick = function () { rollbackSettlement(t); };
            [win, lose, portion, cash, undo].forEach(function (b) { actions.appendChild(b); });
            tr.appendChild(actions);
            body.appendChild(tr);
        });
    }

    var list = document.getElementById('matches');
    CONFIG.matches.forEach(function (m) {
        var card = el('div', null, 'card match');
        card.appendChild(el('div', m.home + ' v ' + m.away));
        var odds = el('div', null, 'odds');
        ['1', 'X', '2'].forEach(function (pick, i) {
            var b = el('button', pick + '  ' + m.odds[i]);
            b.onclick = function () { placeBet(m.home + ' v ' + m.away + ': ' + pick, m.odds[i]); };
            odds.appendChild(b);
        });
        card.appendChild(odds);
        list.appendChild(card);
    });

    document.getElementById('late').onclick = function () { act({ op: 'late-bet', stake: stake(), odds: 2 }); };
    render();
})();
`

/**
 * The book's HTML. `session` is null for an unknown or expired session: the
 * page then says so and carries no script.
 */
export function bookPageHtml(opts: { session: string | null; lang: string; currency?: string }): string {
    const head = `<!doctype html>
<html lang="${escapeHtml(opts.lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IGCORE simulator</title>
<style>${STYLE}</style>
</head>`

    if (!opts.session) {
        return `${head}
<body>
<h1>IGCORE simulator</h1>
<div class="card">This session is unknown or has expired. Open Sports again to start a new one.</div>
</body>
</html>`
    }

    const config = { session: opts.session, matches: MATCHES }
    return `${head}
<body>
<div class="banner">Staging simulator. Every button sends a signed IGCORE callback to this API's real callback routes and moves the wallet.</div>
<h1>IGCORE simulator</h1>
<p class="note">Currency ${escapeHtml(opts.currency ?? '')} · language ${escapeHtml(opts.lang)}</p>

<label>Stake <input id="stake" type="number" min="1" step="1" value="10"></label>

<h2>Matches</h2>
<div id="matches"></div>

<h2>Tickets</h2>
<table>
<thead><tr><th>Ticket</th><th>Selection</th><th>Stake</th><th>Odds</th><th>Status</th><th>Actions</th></tr></thead>
<tbody id="tickets"></tbody>
</table>

<h2>Late answer</h2>
<div class="card match">
<span>A bet the CLIENT answered too late: IGCORE cancels it and sends its rollback.</span>
<button id="late" class="primary">Late bet (rolled back)</button>
</div>

<h2>Log</h2>
<div id="log"></div>

<script type="application/json" id="config">${scriptJson(config)}</script>
<script>${SCRIPT}</script>
</body>
</html>`
}
