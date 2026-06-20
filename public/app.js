'use strict';

const DEHU = '/signalk/v1/api/vessels/self/environment/inside/dehumidifier';
const ACCESS_URL = '/signalk/v1/access/requests';
const TOKEN_KEY = 'arida-sk-token';
const CLIENT_KEY = 'arida-client-id';
const POLL_MS = 4000;
const REAL_FAULTS = ['TILTED', 'CHECK', 'FULL'];

const el = (id) => document.getElementById(id);
const msg = el('msg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pendingPut = null;
let busy = false;
let requesting = false;

function getToken() {
    return localStorage.getItem(TOKEN_KEY);
}

function getClientId() {
    let id = localStorage.getItem(CLIENT_KEY);
    if (!id) {
        id = 'arida-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        localStorage.setItem(CLIENT_KEY, id);
    }
    return id;
}

function authHeaders(json) {
    const h = {};
    if (json) {
        h['Content-Type'] = 'application/json';
    }
    const t = getToken();
    if (t) {
        h.Authorization = 'Bearer ' + t;
    }
    return h;
}

function setLamp(id, on) {
    el(id).classList.toggle('on', !!on);
}

function setMessage(text, kind) {
    msg.textContent = text || '';
    msg.classList.toggle('error', kind === 'error');
    msg.classList.toggle('info', kind === 'info');
}

function setBusy(state) {
    busy = state;
    document.body.classList.toggle('busy', state);
}

function showAccess(text, isError) {
    el('access').hidden = false;
    el('access-text').textContent = text || '';
    el('access-text').classList.toggle('error', !!isError);
}

function hideAccess() {
    el('access').hidden = true;
}

function render(data) {
    const rh = data.relativeHumidity && data.relativeHumidity.value;
    const target = data.targetHumidity && data.targetHumidity.value;
    const temp = data.temperature && data.temperature.value;
    const power = !!(data.power && data.power.value);
    const fault = (data.fault && data.fault.value) || 'none';
    const state = (data.state && data.state.value) || (power ? 'drying' : 'off');
    const drying = state === 'drying';

    el('humidity').textContent = rh != null ? Math.round(rh * 100) : '--';
    el('temp').textContent = temp != null ? (temp - 273.15).toFixed(1) : '--';

    const targetPct = target != null ? Math.round(target * 100) : null;
    [40, 50, 60].forEach((v) => {
        el('btn-' + v).classList.toggle('active', targetPct === v);
        setLamp('lamp-' + v, targetPct === v);
    });

    const fan = (data.fan && data.fan.value) || null;
    ['LOW', 'HIGH'].forEach((f) => {
        const id = f.toLowerCase();
        el('btn-fan-' + id).classList.toggle('active', fan === f);
        setLamp('lamp-fan-' + id, fan === f);
    });

    el('btn-power').classList.toggle('on', power);
    // While a command is in flight the power-state line shows its feedback (…/✓),
    // so only refresh it from live data when idle.
    if (!busy) {
        el('power-state').textContent = state.charAt(0).toUpperCase() + state.slice(1);
    }
    setLamp('lamp-run', power);
    setLamp('lamp-running', drying);
    setLamp('lamp-wifi', true);

    setLamp('lamp-tank', fault.includes('FULL'));
    setLamp('lamp-check', fault.includes('CHECK'));
    setLamp('lamp-tilt', fault.includes('TILTED'));

    const real = REAL_FAULTS.filter((f) => fault.includes(f));
    if (real.length) {
        setMessage('Fault: ' + real.join(', '), 'error');
    } else if (!busy) {
        setMessage('');
    }
}

function applyOptimistic(subpath, value) {
    if (subpath === 'targetHumidity') {
        const pct = Math.round(value * 100);
        [40, 50, 60].forEach((v) => {
            el('btn-' + v).classList.toggle('active', v === pct);
            setLamp('lamp-' + v, v === pct);
        });
    } else if (subpath === 'power') {
        el('btn-power').classList.toggle('on', !!value);
        setLamp('lamp-run', !!value);
        if (!value) {
            setLamp('lamp-running', false);
        }
    } else if (subpath === 'fan') {
        ['LOW', 'HIGH'].forEach((f) => {
            const id = f.toLowerCase();
            el('btn-fan-' + id).classList.toggle('active', f === value);
            setLamp('lamp-fan-' + id, f === value);
        });
    }
}

async function poll() {
    try {
        const res = await fetch(DEHU, { credentials: 'include' });
        if (!res.ok) {
            throw new Error('HTTP ' + res.status);
        }
        render(await res.json());
    } catch (e) {
        setLamp('lamp-wifi', false);
        setMessage('No data (' + e.message + ')', 'error');
    }
}

async function waitForCompletion(href) {
    for (let i = 0; i < 15; i++) {
        await sleep(400);
        const r = await fetch(href, { credentials: 'include', headers: authHeaders() });
        if (!r.ok) {
            continue;
        }
        const j = await r.json();
        if (j.state === 'COMPLETED') {
            if (j.statusCode && j.statusCode >= 400) {
                throw new Error('device rejected it');
            }
            return;
        }
        if (j.state === 'FAILED') {
            throw new Error('command failed');
        }
    }
    throw new Error('timed out');
}

async function put(subpath, value, btn) {
    if (busy) {
        return;
    }
    setBusy(true);
    btn.classList.add('pending');
    el('power-state').textContent = '…';
    try {
        const res = await fetch(DEHU + '/' + subpath, {
            method: 'PUT',
            credentials: 'include',
            headers: authHeaders(true),
            body: JSON.stringify({ value })
        });
        if (res.status === 401 || res.status === 403) {
            pendingPut = { subpath, value, btn };
            requestAccess();
            return;
        }
        if (!res.ok && res.status !== 202) {
            throw new Error('HTTP ' + res.status);
        }
        hideAccess();
        const body = await res.json().catch(() => ({}));
        if (res.status === 202 && body.href) {
            await waitForCompletion(body.href);
        }
        applyOptimistic(subpath, value);
        el('power-state').textContent = '✓';
    } catch (e) {
        setMessage(e.message, 'error');
    } finally {
        btn.classList.remove('pending');
        setBusy(false);
        setTimeout(poll, 1500);
    }
}

async function pollAccess(href) {
    for (let i = 0; i < 90; i++) {
        await sleep(2000);
        const r = await fetch(href, { credentials: 'include' });
        if (!r.ok) {
            continue;
        }
        const j = await r.json();
        if (j.state === 'COMPLETED') {
            const ar = j.accessRequest || {};
            if (ar.permission === 'APPROVED' && ar.token) {
                return ar.token;
            }
            throw new Error('access ' + (ar.permission || 'denied').toLowerCase());
        }
    }
    throw new Error('timed out — not approved in time');
}

async function requestAccess() {
    if (requesting) {
        return;
    }
    requesting = true;
    showAccess('Requesting access…', false);
    try {
        const res = await fetch(ACCESS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId: getClientId(), description: 'Arida S3L webapp', permissions: 'readwrite' })
        });
        const data = await res.json();
        if (!data.href) {
            throw new Error('no request href');
        }
        showAccess('Approve in Signal K → Security → Access Requests, then it continues automatically…', false);
        const token = await pollAccess(data.href);
        localStorage.setItem(TOKEN_KEY, token);
        hideAccess();
        setMessage('Access granted ✓', 'info');
        if (pendingPut) {
            const p = pendingPut;
            pendingPut = null;
            put(p.subpath, p.value, p.btn);
        }
    } catch (e) {
        showAccess('Access failed: ' + e.message, true);
    } finally {
        requesting = false;
    }
}

el('btn-power').addEventListener('click', () => {
    const on = el('btn-power').classList.contains('on');
    put('power', !on, el('btn-power'));
});

document.querySelectorAll('.target-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        put('targetHumidity', Number(btn.dataset.target) / 100, btn);
    });
});

document.querySelectorAll('.fan-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        put('fan', btn.dataset.fan, btn);
    });
});

el('access-btn').addEventListener('click', requestAccess);

// ---- History chart ---------------------------------------------------------

const HISTORY_URL = '/signalk/v1/api/arida-dehumidifier/history';
const RANGES = [
    { days: 1, label: '1d' },
    { days: 2, label: '2d' },
    { days: 5, label: '5d' },
    { days: 7, label: '7d' },
    { days: 14, label: '14d' }
];
const DEFAULT_DAYS = 1;
const FAN_COLORS = { HIGH: '#2ee27a', LOW: '#176b42' };
const NO_FAN_COLOR = '#45585f';
const LINE_STYLE = {
    relativeHumidity: { color: '#58a6ff', dash: [] },
    targetHumidity: { color: '#f2b134', dash: [5, 4] }
};

const historyStatus = el('history-status');
let chart = null;
let historyDays = DEFAULT_DAYS;

function setHistoryStatus(text, isError) {
    historyStatus.textContent = text || '';
    historyStatus.classList.toggle('error', !!isError);
}

function fmtTick(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    if (historyDays <= 2) {
        return pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1);
}

function fmtFull(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' +
        pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function buildChart() {
    const ctx = el('chart').getContext('2d');
    chart = new Chart(ctx, {
        type: 'bar',
        data: { datasets: [] },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            parsing: false,
            interaction: { mode: 'nearest', intersect: false, axis: 'x' },
            scales: {
                x: {
                    type: 'linear',
                    ticks: {
                        color: '#8aa0ad',
                        font: { size: 10 },
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 7,
                        callback: (v) => fmtTick(v)
                    },
                    grid: { color: 'rgba(255,255,255,0.06)' }
                },
                y: {
                    min: 0,
                    max: 100,
                    ticks: { color: '#8aa0ad', font: { size: 10 }, callback: (v) => v + '%' },
                    grid: { color: 'rgba(255,255,255,0.06)' }
                }
            },
            plugins: {
                legend: {
                    labels: {
                        color: '#e8eef1',
                        usePointStyle: true,
                        boxWidth: 8,
                        font: { size: 11 },
                        // Runtime bars are explained by the HTML fan-colour legend,
                        // so keep only the humidity lines in the chart legend.
                        filter: (item) => item.text !== 'Runtime'
                    }
                },
                tooltip: {
                    callbacks: {
                        title: (items) => items.length ? fmtFull(items[0].parsed.x) : '',
                        label: (item) => {
                            if (item.parsed.y == null) {
                                return item.dataset.label + ': –';
                            }
                            let s = item.dataset.label + ': ' + item.parsed.y.toFixed(0) + '%';
                            const f = item.dataset.fanMode && item.dataset.fanMode[item.dataIndex];
                            if (f) {
                                s += ' (' + (f === 'HIGH' ? 'high' : 'low') + ' fan)';
                            }
                            return s;
                        }
                    }
                }
            }
        }
    });
}

async function loadHistory(days) {
    historyDays = days;
    setHistoryStatus('Loading…', false);
    document.querySelectorAll('#ranges button').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.days) === days);
    });
    try {
        const r = await fetch(HISTORY_URL + '?days=' + days, {
            cache: 'no-store',
            credentials: 'include'
        });
        if (!r.ok) {
            let m = 'HTTP ' + r.status;
            try { const j = await r.json(); if (j.error) { m = j.error; } } catch (e) {}
            throw new Error(m);
        }
        const data = await r.json();
        chart.data.datasets = data.series.map((s) => {
            if (s.key === 'runtime') {
                const fanMode = (s.fan || []).map(([, f]) => f);
                return {
                    type: 'bar',
                    label: s.label,
                    data: s.points.map(([t, v]) => ({ x: t, y: v })),
                    fanMode: fanMode,
                    backgroundColor: fanMode.map((f) => f ? FAN_COLORS[f] : NO_FAN_COLOR),
                    borderWidth: 0,
                    order: 2
                };
            }
            const style = LINE_STYLE[s.key] || { color: '#8aa0ad', dash: [] };
            return {
                type: 'line',
                label: s.label,
                data: s.points.map(([t, v]) => ({ x: t, y: v })),
                borderColor: style.color,
                backgroundColor: style.color,
                borderDash: style.dash,
                borderWidth: 1.8,
                pointRadius: 0,
                tension: 0.2,
                fill: false,
                spanGaps: false,
                order: 1
            };
        });
        chart.update();
        const total = chart.data.datasets.reduce((n, d) => n + d.data.filter((p) => p.y != null).length, 0);
        const rm = data.runtimeMinutes;
        const per = rm >= 60 ? (rm / 60) + ' h' : rm + ' min';
        setHistoryStatus(total === 0 ? 'No data in range.' : 'Runtime per ' + per, false);
    } catch (e) {
        setHistoryStatus('Error: ' + e.message, true);
    }
}

RANGES.forEach((r) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = r.label;
    b.dataset.days = r.days;
    b.addEventListener('click', () => loadHistory(r.days));
    el('ranges').appendChild(b);
});

buildChart();
loadHistory(DEFAULT_DAYS);

poll();
setInterval(poll, POLL_MS);
