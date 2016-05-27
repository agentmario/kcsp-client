"use strict"

import http from 'http';
import net from 'net';
import url from 'url';
import request from 'request';
import config from './config'

let PROXY, RETRY, TIMEOUT, DELAY;


function makeRequest(opts) {
    return new Promise((resolve, reject) => {
        request(opts, (err, res, body) => {
            if (err) {
                reject(err)
            } else {
                resolve(res)
            }
        })
    })
}

function delay(ms) {
    return new Promise((resolve, reject) => {
        setTimeout(() => resolve(), ms)
    })
}

function log(desc, msg) {
    console.log(desc, ':', msg)
}


function filterHeaders(origin) {
    let headers = {}
    for (let key in origin) {
        if (! ['connection', 'proxy-connection', 'cache-token', 'request-uri'].includes(key)) {
            headers[key] = origin[key]
        }
    }
    return headers
}

function getRequestId(req) {
    return Date.now().toString(36)
}

async function onRequest(req, resp) {
    let body = new Buffer(0)
    req.on('data', (chunk) => {
        body = Buffer.concat([body, chunk])
    })
    req.on('end', async () => {
        let opts = {
            method:  req.method,
            url:     req.url,
            body:    (body.length > 0) ? body : null,
            headers: filterHeaders(req.headers),
            proxy:   PROXY,
            timeout: TIMEOUT,
            encoding: null,
            followRedirect: false
        }
        let token = getRequestId(req)
        opts.headers['request-uri'] = opts.url
        opts.headers['cache-token'] = token

        let oUrl = url.parse(opts.url)
        let desc = `${token} ${oUrl.pathname}`
        let stime = Date.now()

        let rr = null
        for (let i of Array(RETRY).keys()) {
            log(desc, `Try # ${i}`)
            try {
                rr = await makeRequest(opts)
                if (! (rr.statusCode === 503)) {
                    break
                }
            } catch (e) {
                if (! ['ECONNRESET', 'ENOTFOUND', 'ESOCKETTIMEDOUT', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'EPIPE', 'EAI_AGAIN'].includes(e.code)) {
                    console.error(e)
                }
            }
            await delay(DELAY)
        }
        if (rr) {
            resp.writeHead(rr.statusCode, filterHeaders(rr.headers))
            resp.end(rr.body)
        } else {
            resp.writeHead(503)
            resp.end()
        }

        let etime = Date.now()
        log(desc, `Fin ${(etime - stime) / 1000}s`)
    })
}

async function onConnect(req, sock) {
    let desc = `CONNECT ${req.url}`
    log(desc, 'accepted')

    let rSock = net.createConnection({
        host: config.host,
        port: config.port,
    })
    rSock.on('connect', () => {
        log(desc, `connect`)
        rSock.write(`CONNECT ${req.url} HTTP/${req.httpVersion}\r\n\r\n`)
        sock.pipe(rSock)
        rSock.pipe(sock)
    })
    rSock.on('error', (err) => {
        log(desc, `error\n\t${err}`)
        sock.end()
        rSock.end()
    })
    sock.on('close', () => rSock.end())
    rSock.on('close', () => sock.end())
}

let httpd = http.createServer()
httpd.on('request', onRequest)
httpd.on('connect', onConnect)
httpd.listen(config.local, '127.0.0.1', () => {
    PROXY = `http://${config.host}:${config.port}/`
    RETRY = config.retry
    TIMEOUT = config.timeout * 1000
    DELAY = config.delay * 1000

    let port = httpd.address().port
    console.log(`Upstream proxy server is ${PROXY}`)
    console.log(`Local proxy server listen at ${port}`)
})

module.exports = httpd;
