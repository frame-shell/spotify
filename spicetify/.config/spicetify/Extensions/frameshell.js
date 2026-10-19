// frameshell – Spicetify extension that lets the launcher search and control Spotify.
//
// It connects to the Quickshell shell over a local WebSocket (services/Spotify.qml) and
// answers requests there. Searching uses the client's own quick search (the same one as
// Ctrl+K in Spotify) plus your library, so no Spotify developer app is needed; if that
// internal search changes, it falls back to the Web API with the client's own login.
//
// After a hello with the token from frameshell-token.js, the shell sends
// Requests:{ id, cmd: "search", query } | { id, cmd: "play", uri, queue }
//                          | { id, cmd: "control", action, seconds }
// Answers:                  { id, ok: true, data } | { id, ok: false, error }
//
// Not tested yet (waits for the move to Linux). Spotify's internal names change now and
// then; the search tries several and logs to the DevTools console (spicetify enable-devtools).

(async function frameshell() {
    // Must match spotifyPort in quickshell/.config/quickshell/config/Config.qml
    const PORT = 48931;
    const RETRY_MS = 3000;
    const LIMIT = 6;

    while (!globalThis.Spicetify?.Player || !Spicetify.Platform || !Spicetify.GraphQL || !Spicetify.CosmosAsync) {
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    const log = (...args) => console.log("[frameshell]", ...args);

    // Written by `frame install spicetify` into frameshell-token.js, which Spotify loads
    // as a second extension; the shell only talks to a client that knows it
    for (let tries = 0; !globalThis.FRAMESHELL_TOKEN; tries++) {
        if (tries === 20) log("no token yet, run: frame install spicetify");
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    // ── Results in one shape for the launcher ────────────────

    // { kind: "track" | "artist" | "album" | "playlist", uri, title, subtitle, image, length (s) }
    function item(kind, uri, title, subtitle, image, length) {
        return { kind, uri, title: title ?? "", subtitle: subtitle ?? "", image: image ?? "", length: length ?? 0 };
    }

    // The smallest picture that is still large enough for a launcher row
    function pickImage(sources) {
        const list = (sources ?? []).filter(s => s?.url);
        if (list.length === 0) return "";
        const fitting = list.filter(s => !s.width || s.width >= 64).sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
        return (fitting[0] ?? list[0]).url;
    }

    function names(artists) {
        return (artists ?? []).map(a => a?.profile?.name ?? a?.name).filter(Boolean).join(", ");
    }

    // Internal search response (searchV2), parsed loosely because the shape moves around
    function fromGraphQL(data) {
        const s = data?.data?.searchV2 ?? data?.searchV2 ?? {};
        const out = [];
        for (const wrapper of s.tracksV2?.items ?? s.tracks?.items ?? []) {
            const t = wrapper?.item?.data ?? wrapper?.data ?? wrapper;
            if (!t?.uri) continue;
            out.push(item("track", t.uri, t.name, `${names(t.artists?.items)} · ${t.albumOfTrack?.name ?? ""}`,
                pickImage(t.albumOfTrack?.coverArt?.sources), Math.round((t.duration?.totalMilliseconds ?? 0) / 1000)));
        }
        for (const wrapper of s.artists?.items ?? []) {
            const a = wrapper?.data ?? wrapper;
            if (a?.uri) out.push(item("artist", a.uri, a.profile?.name, "artist", pickImage(a.visuals?.avatarImage?.sources)));
        }
        for (const wrapper of s.albumsV2?.items ?? s.albums?.items ?? []) {
            const a = wrapper?.data ?? wrapper;
            if (a?.uri) out.push(item("album", a.uri, a.name, `album · ${names(a.artists?.items)}`, pickImage(a.coverArt?.sources)));
        }
        for (const wrapper of s.playlists?.items ?? []) {
            const p = wrapper?.data ?? wrapper;
            if (p?.uri) out.push(item("playlist", p.uri, p.name, `playlist · ${p.ownerV2?.data?.name ?? ""}`, pickImage(p.images?.items?.[0]?.sources)));
        }
        return out;
    }

    function fromWebApi(r) {
        const out = [];
        for (const t of r?.tracks?.items ?? [])
            if (t) out.push(item("track", t.uri, t.name, `${names(t.artists)} · ${t.album?.name ?? ""}`, pickImage(t.album?.images), Math.round(t.duration_ms / 1000)));
        for (const a of r?.artists?.items ?? [])
            if (a) out.push(item("artist", a.uri, a.name, "artist", pickImage(a.images)));
        for (const a of r?.albums?.items ?? [])
            if (a) out.push(item("album", a.uri, a.name, `album · ${names(a.artists)}`, pickImage(a.images)));
        for (const p of r?.playlists?.items ?? [])
            if (p) out.push(item("playlist", p.uri, p.name, `playlist · ${p.owner?.display_name ?? ""}`, pickImage(p.images)));
        return out;
    }

    // Your own playlists, straight from the client (no network request)
    async function libraryPlaylists(query) {
        try {
            const root = await Spicetify.Platform.RootlistAPI.getContents();
            const flat = [];
            (function walk(items) {
                for (const i of items ?? []) {
                    if (i.type === "folder") walk(i.items);
                    else if (i.type === "playlist") flat.push(i);
                }
            })(root?.items);
            const q = query.toLowerCase();
            return flat.filter(p => (p.name ?? "").toLowerCase().includes(q)).slice(0, 4)
                .map(p => item("playlist", p.uri, p.name, "your playlist", p.images?.[0]?.url ?? ""));
        } catch (e) {
            log("library", e);
            return [];
        }
    }

    async function search(query) {
        const own = await libraryPlaylists(query);
        const defs = Spicetify.GraphQL.Definitions ?? {};
        // The client's quick search first, then the full search page, then the Web API
        for (const name of ["searchModalResults", "searchDesktop"]) {
            if (!defs[name]) continue;
            try {
                const data = await Spicetify.GraphQL.Request(defs[name], {
                    searchTerm: query, offset: 0, limit: LIMIT, numberOfTopResults: 5,
                    includeAudiobooks: false, includePreReleases: false
                });
                const found = fromGraphQL(data);
                if (found.length) return { source: name, items: own.concat(found) };
            } catch (e) {
                log(name, e);
            }
        }
        const web = await Spicetify.CosmosAsync.get(
            `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track,artist,album,playlist&limit=${LIMIT}`);
        // CosmosAsync returns errors (429, 403) as objects instead of throwing
        if (web?.error) throw new Error(web.error.message ?? `web api ${web.error.status}`);
        return { source: "web api", items: own.concat(fromWebApi(web)) };
    }

    // ── Playback ─────────────────────────────────────────────

    async function play(uri, queue) {
        if (queue) {
            await Spicetify.addToQueue([{ uri }]);
            return "queued";
        }
        await Spicetify.Player.playUri(uri);
        return "playing";
    }

    // Player.seek reads values up to 1 as a fraction of the track, so tiny offsets become 0
    function seekTo(ms) {
        const P = Spicetify.Player;
        const clamped = Math.max(0, Math.min(P.getDuration(), ms));
        P.seek(clamped <= 1 ? 0 : clamped);
    }

    function control(action, seconds) {
        const P = Spicetify.Player;
        const ms = Math.round((seconds ?? 0) * 1000);
        switch (action) {
        case "play": P.play(); break;
        case "pause": P.pause(); break;
        case "toggle": P.togglePlay(); break;
        case "next": P.next(); break;
        case "prev": P.back(); break;
        case "forward": seekTo(P.getProgress() + ms); break;
        case "back": seekTo(P.getProgress() - ms); break;
        case "jump": seekTo(ms); break;
        case "shuffle": P.toggleShuffle(); break;
        case "repeat": P.toggleRepeat(); break;
        case "like": P.toggleHeart(); break;
        default: throw new Error(`unknown action ${action}`);
        }
        return action;
    }

    // ── Connection to the shell ──────────────────────────────

    async function handle(socket, message) {
        let request;
        try {
            request = JSON.parse(message);
        } catch (e) {
            return;
        }
        const reply = (ok, payload) => socket.send(JSON.stringify(Object.assign({ id: request.id, ok }, payload)));
        try {
            let data;
            if (request.cmd === "search") data = await search(String(request.query ?? ""));
            else if (request.cmd === "play") data = await play(request.uri, !!request.queue);
            else if (request.cmd === "control") data = control(request.action, request.seconds);
            else throw new Error(`unknown command ${request.cmd}`);
            reply(true, { data });
        } catch (e) {
            reply(false, { error: String(e?.message ?? e) });
        }
    }

    // The shell may start after Spotify or restart, so keep trying quietly
    function connect() {
        let socket;
        try {
            socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
        } catch (e) {
            // A blocked connection (content security policy) throws here; then only the
            // Web API path in frame-spotify works, see docs/spotify.md
            log("cannot open the socket", e);
            setTimeout(connect, RETRY_MS * 10);
            return;
        }
        socket.onopen = () => {
            log("connected to the shell");
            socket.send(JSON.stringify({ hello: "frameshell", version: 1, token: globalThis.FRAMESHELL_TOKEN }));
        };
        socket.onmessage = event => handle(socket, event.data);
        socket.onclose = () => setTimeout(connect, RETRY_MS);
    }
    connect();
})();
