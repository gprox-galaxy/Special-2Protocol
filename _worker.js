import { connect } from "cloudflare:sockets";

// ============================================
// ENV VARIABLES (Set in Cloudflare Dashboard)
// ============================================
var userID = "";                    // REQUIRED: Set UUID env variable
var proxyIP = "cdn-b100.xn--b6gac.eu.org";      // Fallback ProxyIP

// 🔗 Secret WebSocket Path (Cloudflare Dashboard တွင် WS_PATH အနေဖြင့် ထည့်နိုင်သည်)
var wsPath = "/your-secret-path";   // Fallback Secret Path (Default)

// 🔗 သင့် GitHub ပေါ်က PROXYIP.txt ရဲ့ Raw Link ကို ဒီနေရာမှာ ထည့်ပါ
var githubProxyURL = "https://raw.githubusercontent.com/proxzero/galaxy-subdomain/refs/heads/main/PROXYIP.txt";

// DoH Provider URL
var dohURL = "https://cloudflare-dns.com/dns-query";

function isValidUUID(uuid) {
    if (!uuid) return false;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

// ============================================
// Hybrid Proxy IP Pool (Local Fast Safe List)
// ============================================
const DEFAULT_LOCAL_PROXIES = [
    "cdn-b100.xn--b6gac.eu.org",
    "cdn.xn--b6gac.eu.org",
    "bpb.yousef.isegaro.com",
    "icook.hk",
    "icook.tw",
    "www.visa.com.sg"
];

// In-memory active proxy cache pool (Hybrid)
let activeProxyPool = [...DEFAULT_LOCAL_PROXIES];

// GitHub & Local Hybrid Proxy IP Function
async function getHybridProxyIP(defaultProxy, rawUrl) {
    if (!rawUrl || rawUrl.includes("YOUR_USERNAME")) {
        return activeProxyPool[Math.floor(Math.random() * activeProxyPool.length)] || defaultProxy;
    }
    try {
        const response = await fetch(rawUrl, {
            cf: { cacheTtl: 300, cacheEverything: true } // 5 မိနစ် Cache မှတ်ထားမည်
        });
        if (response.ok) {
            const text = await response.text();
            const fetchedIPs = text.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0 && !line.startsWith('#'));
            
            if (fetchedIPs.length > 0) {
                activeProxyPool = Array.from(new Set([...fetchedIPs, ...DEFAULT_LOCAL_PROXIES]));
                if (defaultProxy && !activeProxyPool.includes(defaultProxy)) {
                    activeProxyPool.unshift(defaultProxy);
                }
            }
        }
    } catch (err) {
        console.warn("GitHub ProxyIP Fetch Error, falling back to local pool:", err);
    }
    return activeProxyPool[Math.floor(Math.random() * activeProxyPool.length)] || defaultProxy;
}

// ============================================
// Ads & Tracker Block List
// ============================================
const AD_DOMAIN_SUFFIXES = [
    "doubleclick.net",
    "googleadservices.com",
    "googlesyndication.com",
    "adservice.google.com",
    "pagead2.googlesyndication.com",
    "adcolony.com",
    "appsflyer.com",
    "unityads.unity3d.com",
    "vungle.com",
    "applovin.com",
    "flurry.com",
    "adjust.com",
    "branch.io",
    "admob.com",
    "mopub.com",
    "criteo.com",
    "taboola.com",
    "outbrain.com",
    "scorecardresearch.com",
    "quantserve.com",
    "popads.net",
    "inmobi.com",
    "adroll.com",
    "amazon-adsystem.com",
    "adsafeprotected.com",
    "moatads.com",
    "openx.net",
    "rubiconproject.com",
    "pubmatic.com"
];

function isAdDomain(domain) {
    if (!domain) return false;
    const lower = domain.toLowerCase().trim();
    if (AD_DOMAIN_SUFFIXES.some(suffix => lower === suffix || lower.endsWith("." + suffix))) {
        return true;
    }
    if (/^(ad|ads|adservice|adserver|telemetry|track|tracker|analytics)\./i.test(lower)) {
        return true;
    }
    return false;
}

// ============================================
// Direct Local Bypass & Intranet Logic
// ============================================
const DIRECT_BYPASS_DOMAINS = [
    "localhost",
    "local",
    "internal",
    "lan",
    "home.arpa"
];

function isPrivateOrLocalAddress(address) {
    if (!address) return false;
    const lower = address.toLowerCase().trim();
    
    if (DIRECT_BYPASS_DOMAINS.some(d => lower === d || lower.endsWith("." + d))) {
        return true;
    }

    // IPv4 Loopback & Private Ranges
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
    const match172 = lower.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
    if (match172) {
        const secondOctet = parseInt(match172[1], 10);
        if (secondOctet >= 16 && secondOctet <= 31) return true;
    }
    if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;

    // IPv6 checks
    if (lower === "::1" || lower.startsWith("fc00:") || lower.startsWith("fe80:") || lower.startsWith("fd")) {
        return true;
    }

    return false;
}

var worker_default = {
    async fetch(request, env, ctx) {
        // 1. Load from environment variables (Cloudflare Dashboard)
        userID = env.UUID || env.uuid || userID;
        proxyIP = env.PROXYIP || env.proxyip || env.PROXY_IP || proxyIP;
        githubProxyURL = env.PROXY_LIST_URL || githubProxyURL;
        dohURL = env.DNS_RESOLVER_URL || dohURL;

        // 🔒 Secret WebSocket Path ကို Cloudflare Dashboard Env မှ ဖတ်ယူခြင်း
        const rawSecretPath = env.WS_PATH || env.ws_path || env.WSPATH || env.PATH || wsPath;
        const expectedSecretPath = rawSecretPath.startsWith("/") ? rawSecretPath : "/" + rawSecretPath;

        // Client ထံမှ လာသော URL Path ကို စစ်ဆေးခြင်း
        const url = new URL(request.url);
        const pathname = url.pathname;

        // Validate UUID after loading from env
        if (!isValidUUID(userID)) {
            return new Response(
                `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Config Error</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;}
.box{background:#1e293b;padding:40px;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,0.3);}
h1{color:#f87171;} code{background:#334155;padding:2px 8px;border-radius:4px;}</style>
</head>
<body>
<div class="box">
<h1>⚠️ UUID Not Configured</h1>
<p>Please set the <code>UUID</code> environment variable in Cloudflare Dashboard.</p>
<p>Generate one at <a href="https://www.uuidgenerator.net" style="color:#38bdf8;">uuidgenerator.net</a></p>
</div>
</body></html>`,
                { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } }
            );
        }

        const upgradeHeader = request.headers.get("Upgrade");
        const contentType = request.headers.get("Content-Type") || request.headers.get("content-type") || "";

        // ============================================
        // 🔒 WebSocket proxy request & Secret Path Validation
        // ============================================
        if (upgradeHeader === "websocket") {
            // Path မမှန်ကန်ပါက 404 ပြန်ပေးပြီး VLESS သို့ လုံးဝပေးမဝင်ပါ
            if (expectedSecretPath !== "/" && pathname !== expectedSecretPath) {
                return new Response("404 Not Found", { 
                    status: 404, 
                    statusText: "Not Found",
                    headers: { "Content-Type": "text/plain; charset=utf-8" } 
                });
            }
            // Path မှန်ကန်မှသာ WebSocket connection ကို လက်ခံပြီး ဆက်လက်အလုပ်လုပ်မည်
            return await proxyOverWSHandler(request);
        }

        // ============================================
        // 🔒 gRPC HTTP/2 Stream proxy request
        // ============================================
        if (contentType.includes("application/grpc")) {
            if (expectedSecretPath !== "/" && pathname !== expectedSecretPath) {
                return new Response("404 Not Found", { 
                    status: 404, 
                    statusText: "Not Found",
                    headers: { "Content-Type": "text/plain; charset=utf-8" } 
                });
            }
            return await proxyOverGRPCHandler(request);
        }

        // Web Browser မှ လာသမျှ Request တိုင်းကို Galaxy HTML Page သို့ ပို့မည်
        return new Response(getGalaxyPage(), {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" }
        });
    }
};

// ============================================
// gRPC HTTP/2 Stream Proxy Handler
// ============================================
function makeGrpcFrame(data) {
    const rawBytes = data instanceof Uint8Array 
        ? data 
        : (data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data));
    const len = rawBytes.byteLength;
    const frame = new Uint8Array(5 + len);
    frame[0] = 0; // Uncompressed flag
    frame[1] = (len >> 24) & 255;
    frame[2] = (len >> 16) & 255;
    frame[3] = (len >> 8) & 255;
    frame[4] = len & 255;
    frame.set(rawBytes, 5);
    return frame;
}

async function proxyOverGRPCHandler(request) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    let address = "";
    let portWithRandomLog = "";

    const log = (info, event) => {
        console.log(`[gRPC][${address}:${portWithRandomLog}] ${info}`, event || "");
    };

    let remoteSocketWrapper = { value: null };
    let udpStreamWrite = null;
    let isDns = false;
    let accumulatedBuffer = new Uint8Array(0);

    const grpcClient = {
        isGrpc: true,
        send: async (data) => {
            try {
                const framed = makeGrpcFrame(data);
                await writer.write(framed);
            } catch (err) {
                log("gRPC send error", err);
            }
        },
        close: async () => {
            try {
                await writer.close();
            } catch (err) {}
        }
    };

    (async () => {
        const reader = request.body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    log("gRPC body stream finished");
                    break;
                }
                if (!value || value.byteLength === 0) continue;

                if (isDns && udpStreamWrite) {
                    await udpStreamWrite(value);
                    continue;
                }

                if (remoteSocketWrapper.value) {
                    const tcpWriter = remoteSocketWrapper.value.writable.getWriter();
                    await tcpWriter.write(value);
                    tcpWriter.releaseLock();
                    continue;
                }

                // Append new bytes
                const combined = new Uint8Array(accumulatedBuffer.length + value.length);
                combined.set(accumulatedBuffer, 0);
                combined.set(value, accumulatedBuffer.length);
                accumulatedBuffer = combined;

                // De-frame gRPC message or handle raw buffer
                let payload = null;
                if (accumulatedBuffer.length >= 5 && accumulatedBuffer[0] === 0) {
                    const msgLen = (accumulatedBuffer[1] << 24) | (accumulatedBuffer[2] << 16) | (accumulatedBuffer[3] << 8) | accumulatedBuffer[4];
                    if (accumulatedBuffer.length >= 5 + msgLen) {
                        payload = accumulatedBuffer.slice(5, 5 + msgLen);
                        accumulatedBuffer = accumulatedBuffer.slice(5 + msgLen);
                    }
                } else if (accumulatedBuffer.length >= 24) {
                    payload = accumulatedBuffer;
                    accumulatedBuffer = new Uint8Array(0);
                }

                if (!payload || payload.length < 24) {
                    continue;
                }

                const result = processVlessHeader(payload.buffer ? payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) : payload, userID);
                if (result.hasError) {
                    throw new Error(result.message);
                }

                const {
                    addressRemote = "",
                    portRemote = 443,
                    rawDataIndex,
                    responseHeader,
                    isUDP
                } = result;

                address = addressRemote;
                portWithRandomLog = `${portRemote} ${isUDP ? "udp" : "tcp"}`;

                if (isUDP && portRemote !== 53) {
                    throw new Error("UDP proxy only enabled for DNS (port 53)");
                }
                if (isUDP && portRemote === 53) {
                    isDns = true;
                }

                const rawClientData = payload.slice(rawDataIndex);

                if (isDns) {
                    const { write } = await handleUDPOutBound(grpcClient, responseHeader, log);
                    udpStreamWrite = write;
                    if (rawClientData.length > 0) {
                        await udpStreamWrite(rawClientData);
                    }
                    continue;
                }

                handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, grpcClient, responseHeader, log);
            }
        } catch (err) {
            log("gRPC processing error", err);
        } finally {
            safeCloseClient(grpcClient);
        }
    })();

    return new Response(readable, {
        status: 200,
        headers: {
            "Content-Type": "application/grpc",
            "Trailer": "grpc-status, grpc-message"
        }
    });
}

// ============================================
// WebSocket Proxy Handler
// ============================================
async function proxyOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    let address = "";
    let portWithRandomLog = "";

    const log = (info, event) => {
        console.log(`[WS][${address}:${portWithRandomLog}] ${info}`, event || "");
    };

    const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

    let remoteSocketWrapper = { value: null };
    let udpStreamWrite = null;
    let isDns = false;

    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (isDns && udpStreamWrite) {
                return udpStreamWrite(chunk);
            }
            if (remoteSocketWrapper.value) {
                const writer = remoteSocketWrapper.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            // Only VLESS Header Processing
            let result = processVlessHeader(chunk, userID);

            if (result.hasError) {
                throw new Error(result.message);
            }

            const {
                addressRemote = "",
                portRemote = 443,
                rawDataIndex,
                responseHeader,
                isUDP
            } = result;

            address = addressRemote;
            portWithRandomLog = `${portRemote} ${isUDP ? "udp" : "tcp"}`;

            if (isUDP && portRemote !== 53) {
                throw new Error("UDP proxy only enabled for DNS (port 53)");
            }
            if (isUDP && portRemote === 53) {
                isDns = true;
            }

            const rawClientData = chunk.slice(rawDataIndex);

            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, responseHeader, log);
                udpStreamWrite = write;
                udpStreamWrite(rawClientData);
                return;
            }

            handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, webSocket, responseHeader, log);
        },
        close() {
            log("WebSocket stream closed");
        },
        abort(reason) {
            log("WebSocket stream aborted", JSON.stringify(reason));
        }
    })).catch((err) => {
        log("WebSocket pipeTo error", err);
    });

    return new Response(null, { status: 101, webSocket: client });
}

// ============================================
// TCP Outbound with AdBlock & Direct Bypass
// ============================================
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, client, responseHeader, log) {
    // 1. Ads Block Check
    if (isAdDomain(addressRemote)) {
        log(`[AdBlock] Blocked outbound connection to ad domain: ${addressRemote}`);
        safeCloseClient(client);
        return;
    }

    // 2. Direct Local Bypass Check
    const isDirect = isPrivateOrLocalAddress(addressRemote);
    if (isDirect) {
        log(`[DirectBypass] Local/private route detected for ${addressRemote}:${portRemote}. Connecting directly without proxy fallback.`);
    }

    async function connectAndWrite(address, port) {
        const tcpSocket2 = connect({ hostname: address, port });
        remoteSocket.value = tcpSocket2;
        log(`Connected to ${address}:${port}`);
        const writer = tcpSocket2.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket2;
    }

    async function retry() {
        if (isDirect) {
            log(`[DirectBypass] Target connection failed, direct route will not fallback to external proxy.`);
            safeCloseClient(client);
            return;
        }

        // Hybrid Proxy IP (Local Fast Safe List + GitHub Cache)
        const activeProxy = await getHybridProxyIP(proxyIP, githubProxyURL);
        const target = activeProxy || addressRemote;
        log(`Retrying connection via Hybrid ProxyIP: ${target}`);
        
        try {
            const tcpSocket2 = await connectAndWrite(target, portRemote);
            tcpSocket2.closed.catch((error) => {
                console.log("Retry tcpSocket closed error", error);
            }).finally(() => {
                safeCloseClient(client);
            });
            remoteSocketToClient(tcpSocket2, client, responseHeader, null, log);
        } catch (err) {
            log("Retry connect error", err);
            safeCloseClient(client);
        }
    }

    try {
        const tcpSocket = await connectAndWrite(addressRemote, portRemote);
        remoteSocketToClient(tcpSocket, client, responseHeader, isDirect ? null : retry, log);
    } catch (err) {
        log("Initial TCP connect error", err);
        if (!isDirect) {
            await retry();
        } else {
            safeCloseClient(client);
        }
    }
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
    let readableStreamCancel = false;
    return new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener("message", (event) => {
                controller.enqueue(event.data);
            });
            webSocketServer.addEventListener("close", () => {
                safeCloseWebSocket(webSocketServer);
                controller.close();
            });
            webSocketServer.addEventListener("error", (err) => {
                log("WebSocket error");
                controller.error(err);
            });

            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        cancel(reason) {
            log(`ReadableStream canceled: ${reason}`);
            readableStreamCancel = true;
            safeCloseWebSocket(webSocketServer);
        }
    });
}

function processVlessHeader(vlessBuffer, userID2) {
    if (vlessBuffer.byteLength < 24) {
        return { hasError: true, message: "Invalid VLESS data" };
    }

    const version = new Uint8Array(vlessBuffer.slice(0, 1));
    const slicedBuffer = new Uint8Array(vlessBuffer.slice(1, 17));
    const slicedBufferString = stringify(slicedBuffer);

    const uuids = userID2.includes(",") ? userID2.split(",") : [userID2];
    const isValidUser = uuids.some((userUuid) => slicedBufferString === userUuid.trim());

    if (!isValidUser) {
        return { hasError: true, message: "Invalid VLESS user" };
    }

    const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
    const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

    let isUDP = false;
    if (command === 1) {
        isUDP = false;
    } else if (command === 2) {
        isUDP = true;
    } else {
        return { hasError: true, message: `VLESS command ${command} not supported` };
    }

    const portIndex = 18 + optLength + 1;
    const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);

    let addressIndex = portIndex + 2;
    const addressType = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1))[0];

    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = "";

    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join(".");
            break;
        case 2:
            addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(":");
            break;
        default:
            return { hasError: true, message: `Invalid VLESS address type ${addressType}` };
    }

    if (!addressValue) {
        return { hasError: true, message: "VLESS address value is empty" };
    }

    const responseHeader = new Uint8Array([version[0], 0]);
    return {
        hasError: false,
        addressRemote: addressValue,
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        responseHeader,
        isUDP
    };
}

async function remoteSocketToClient(remoteSocket, client, responseHeader, retry, log) {
    let header = responseHeader;
    let hasIncomingData = false;

    await remoteSocket.readable.pipeTo(new WritableStream({
        async write(chunk, controller) {
            hasIncomingData = true;
            if (client.isGrpc) {
                if (header) {
                    const combined = new Uint8Array(header.length + chunk.byteLength);
                    combined.set(header, 0);
                    combined.set(new Uint8Array(chunk.buffer || chunk, chunk.byteOffset || 0, chunk.byteLength), header.length);
                    await client.send(combined);
                    header = null;
                } else {
                    await client.send(chunk);
                }
            } else {
                if (client.readyState !== 1) {
                    controller.error("WebSocket not open");
                }
                if (header) {
                    client.send(await new Blob([header, chunk]).arrayBuffer());
                    header = null;
                } else {
                    client.send(chunk);
                }
            }
        },
        close() {
            log(`Remote connection closed (had data: ${hasIncomingData})`);
        },
        abort(reason) {
            console.error("Remote readable abort", reason);
        }
    })).catch((error) => {
        console.error("remoteSocketToClient error", error.stack || error);
        safeCloseClient(client);
    });

    if (hasIncomingData === false && retry) {
        log("Retrying connection...");
        retry();
    }
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) {
        return { earlyData: null, error: null };
    }
    try {
        base64Str = base64Str.replace(/-/g, "+").replace(/_/g, "/");
        const decode = atob(base64Str);
        const arrayBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
        return { earlyData: arrayBuffer.buffer, error: null };
    } catch (error) {
        return { earlyData: null, error };
    }
}

var byteToHex = [];
for (let i = 0; i < 256; ++i) {
    byteToHex.push((i + 256).toString(16).slice(1));
}

function unsafeStringify(arr, offset = 0) {
    return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}

function stringify(arr, offset = 0) {
    const uuid = unsafeStringify(arr, offset);
    if (!isValidUUID(uuid)) {
        throw TypeError("Stringified UUID is invalid");
    }
    return uuid;
}

function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === 1 || socket.readyState === 2) {
            socket.close();
        }
    } catch (error) {
        console.error("safeCloseWebSocket error", error);
    }
}

function safeCloseClient(client) {
    if (!client) return;
    try {
        if (client.isGrpc && client.close) {
            client.close();
        } else if (client.readyState === 1 || client.readyState === 2) {
            client.close();
        }
    } catch (error) {
        console.error("safeCloseClient error", error);
    }
}

async function handleUDPOutBound(client, responseHeader, log) {
    let isHeaderSent = false;
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            for (let index = 0; index < chunk.byteLength; ) {
                const lengthBuffer = chunk.slice(index, index + 2);
                const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
                const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
                index = index + 2 + udpPacketLength;
                controller.enqueue(udpData);
            }
        },
        flush(controller) {
        }
    });

    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const resp = await fetch(dohURL, {
                method: "POST",
                headers: { "content-type": "application/dns-message" },
                body: chunk
            });
            const dnsQueryResult = await resp.arrayBuffer();
            const udpSize = dnsQueryResult.byteLength;
            const udpSizeBuffer = new Uint8Array([udpSize >> 8 & 255, udpSize & 255]);

            log(`DoH success, DNS message length: ${udpSize}`);
            const fullPacket = isHeaderSent
                ? new Uint8Array([...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)])
                : new Uint8Array([...responseHeader, ...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]);
            isHeaderSent = true;

            if (client.isGrpc) {
                await client.send(fullPacket);
            } else if (client.readyState === 1) {
                client.send(fullPacket.buffer);
            }
        }
    })).catch((error) => {
        log("DNS UDP error" + error);
    });

    const writer = transformStream.writable.getWriter();
    return { write: (chunk) => writer.write(chunk) };
}

// 🌌 GALAXY TUNNEL VLESS UI PAGE (No Config links, Clean Display)
function getGalaxyPage() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Galaxy-Tunnel VLESS</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body, html {
      width: 100%; height: 100%;
      background: #02060d; overflow: hidden;
      font-family: 'Segoe UI', Arial, sans-serif;
      display: flex; justify-content: center; align-items: center;
    }
    .space-bg {
      position: absolute; width: 100%; height: 100%;
      background: 
        radial-gradient(circle at 50% 35%, rgba(10, 45, 80, 0.7) 0%, transparent 65%),
        radial-gradient(circle at 80% 80%, rgba(0, 150, 200, 0.15) 0%, transparent 50%),
        #02060d;
      z-index: 1;
    }
    .starfield {
      position: absolute; width: 100%; height: 100%;
      background-image: 
        radial-gradient(2px 2px at 20px 30px, #ffffff, rgba(0,0,0,0)),
        radial-gradient(2px 2px at 40px 70px, rgba(0,212,255,0.8), rgba(0,0,0,0)),
        radial-gradient(1px 1px at 90px 40px, #ffffff, rgba(0,0,0,0)),
        radial-gradient(2px 2px at 160px 120px, rgba(0,212,255,0.9), rgba(0,0,0,0));
      background-repeat: repeat; background-size: 220px 220px;
      animation: starTwinkle 4s ease-in-out infinite alternate; opacity: 0.6;
    }
    @keyframes starTwinkle {
      0% { opacity: 0.4; transform: scale(1); }
      100% { opacity: 0.8; transform: scale(1.02); }
    }
    .card-frame {
      position: relative; z-index: 10;
      width: 90vw; max-width: 480px; aspect-ratio: 1 / 1;
      background: rgba(4, 12, 24, 0.75);
      border: 1.5px solid rgba(0, 212, 255, 0.6);
      box-shadow: 0 0 25px rgba(0, 212, 255, 0.25), inset 0 0 25px rgba(0, 212, 255, 0.1);
      backdrop-filter: blur(12px);
      display: flex; flex-direction: column; justify-content: space-between; align-items: center;
      padding: 35px 25px 25px 25px; border-radius: 4px;
    }
    .graphic-container {
      position: relative; width: 230px; height: 230px;
      display: flex; justify-content: center; align-items: center;
    }
    .ring {
      position: absolute; width: 240px; height: 75px;
      border: 2px solid rgba(0, 230, 255, 0.85); border-radius: 50%;
      transform: rotate(-28deg);
      box-shadow: 0 0 15px rgba(0, 212, 255, 0.8), inset 0 0 15px rgba(0, 212, 255, 0.5);
      pointer-events: none; animation: ringGlow 3s ease-in-out infinite alternate;
    }
    @keyframes ringGlow {
      0% { opacity: 0.7; box-shadow: 0 0 12px rgba(0,212,255,0.6); }
      100% { opacity: 1; box-shadow: 0 0 25px rgba(0,212,255,1); }
    }
    canvas { position: absolute; top: 0; left: 0; }
    .content-bottom {
      width: 100%; display: flex; flex-direction: column; align-items: center;
      text-align: center; position: relative;
    }
    .title {
      font-size: 34px; font-weight: 900; font-style: italic;
      color: #ffffff; letter-spacing: 2px; text-transform: uppercase;
      text-shadow: 0 0 12px rgba(255, 255, 255, 0.7); line-height: 1.1;
    }
    .subtitle {
      font-size: 16px; font-weight: 600; color: #7b93a7;
      letter-spacing: 5px; margin-top: 6px; text-transform: uppercase;
    }
    .access-badge {
      align-self: flex-end; margin-top: 15px; font-size: 20px;
      font-weight: 900; font-style: italic; color: #00e5ff;
      text-transform: uppercase; text-align: right; letter-spacing: 1px; line-height: 1.1;
      text-shadow: 0 0 15px rgba(0, 229, 255, 0.85); animation: statusPulse 2s infinite alternate;
    }
    @keyframes statusPulse {
      0% { opacity: 0.8; text-shadow: 0 0 8px rgba(0,229,255,0.5); }
      100% { opacity: 1; text-shadow: 0 0 20px rgba(0,229,255,1); }
    }
  </style>
</head>
<body>
  <div class="space-bg"></div>
  <div class="starfield"></div>
  <div class="card-frame">
    <div class="graphic-container">
      <div class="ring"></div>
      <canvas id="nodeCanvas" width="230" height="230"></canvas>
    </div>
    <div class="content-bottom">
      <h1 class="title">GALAXY-TUNNEL</h1>
      <div class="subtitle">VLESS CONFIG</div>
      <div class="access-badge">
        GALAXY VPROXY<br>IS ACCESS
      </div>
    </div>
  </div>
  <script>
    const canvas = document.getElementById('nodeCanvas');
    const ctx = canvas.getContext('2d');
    const numNodes = 32; const nodes = []; const radius = 75;
    let angleX = 0.004; let angleY = 0.007;

    for (let i = 0; i < numNodes; i++) {
      let theta = Math.acos(Math.random() * 2 - 1);
      let phi = Math.random() * Math.PI * 2;
      nodes.push({
        x: radius * Math.sin(theta) * Math.cos(phi),
        y: radius * Math.sin(theta) * Math.sin(phi),
        z: radius * Math.cos(theta)
      });
    }

    function rotateX(node, angle) {
      let cos = Math.cos(angle); let sin = Math.sin(angle);
      let y1 = node.y * cos - node.z * sin;
      let z1 = node.z * cos + node.y * sin;
      node.y = y1; node.z = z1;
    }

    function rotateY(node, angle) {
      let cos = Math.cos(angle); let sin = Math.sin(angle);
      let y1 = node.y * cos - node.z * sin;
      let z1 = node.z * cos + node.y * sin;
      node.y = y1; node.z = z1;
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let cx = canvas.width / 2; let cy = canvas.height / 2;

      nodes.forEach(node => {
        rotateX(node, angleX);
        rotateY(node, angleY);
      });

      ctx.strokeStyle = 'rgba(0, 220, 255, 0.35)';
      ctx.lineWidth = 1;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          let dist = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y, nodes[i].z - nodes[j].z);
          if (dist < 60) {
            ctx.beginPath();
            ctx.moveTo(nodes[i].x + cx, nodes[i].y + cy);
            ctx.lineTo(nodes[j].x + cx, nodes[j].y + cy);
            ctx.stroke();
          }
        }
      }

      nodes.forEach(node => {
        let size = (node.z + radius) / (2 * radius) * 3 + 2;
        ctx.beginPath();
        ctx.arc(node.x + cx, node.y + cy, size, 0, Math.PI * 2);
        ctx.fillStyle = '#00f0ff';
        ctx.shadowBlur = 8; ctx.shadowColor = '#00f0ff';
        ctx.fill(); ctx.shadowBlur = 0;
      });

      requestAnimationFrame(draw);
    }
    draw();
  </script>
</body>
</html>`;
}

export default worker_default;
