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

    el('humidity').textContent = rh != null ? Math.round(rh * 100) : '--';
    el('temp').textContent = temp != null ? (temp - 273.15).toFixed(1) : '--';

    const targetPct = target != null ? Math.round(target * 100) : null;
    [40, 50, 60].forEach((v) => {
        el('btn-' + v).classList.toggle('active', targetPct === v);
        setLamp('lamp-' + v, targetPct === v);
    });

    el('btn-power').classList.toggle('on', power);
    setLamp('lamp-run', power);
    setLamp('lamp-running', power);
    setLamp('lamp-wifi', true);

    setLamp('lamp-tank', fault.includes('FULL'));
    setLamp('lamp-check', fault.includes('CHECK'));
    setLamp('lamp-tilt', fault.includes('TILTED'));

    const real = REAL_FAULTS.filter((f) => fault.includes(f));
    if (real.length) {
        setMessage('Fault: ' + real.join(', '), 'error');
    } else if (fault.includes('E_Saving')) {
        setMessage('Energy saving', 'info');
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
        setLamp('lamp-running', !!value);
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
    setMessage('Sending…', 'info');
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
        setMessage('Confirmed ✓', 'info');
        setTimeout(poll, 1500);
        setTimeout(() => { if (!busy) { setMessage(''); } }, 1500);
    } catch (e) {
        setMessage(e.message, 'error');
    } finally {
        btn.classList.remove('pending');
        setBusy(false);
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

el('access-btn').addEventListener('click', requestAccess);

poll();
setInterval(poll, POLL_MS);
