import { STATUS_CODES } from 'http'
import stream from 'stream'
import uWS from 'uWebSockets.js'
import bytes from 'bytes'
import * as tonLogger from '@tonjs/logger'

export type TonApp = uWS.TemplatedApp
export type TonAppSSLOptions = {
  ssl?: boolean
  key?: string
  cert?: string
  passphrase?: string
  dhParams?: string
  preferLowMemoryUsage?: boolean
}
export type TonRequest = uWS.HttpRequest
export type TonResponse = uWS.HttpResponse & {
  statusCode?: number
  aborted: boolean
}
export type TonStream = stream.Readable & { size?: number }
export type TonData = string | number | object | TonStream | Error
export type TonHeaders = { [key: string]: string }
export type TonHandler = (
  req: TonRequest,
  res: TonResponse
) => TonData | void | Promise<TonData | void>
export type TonError = Error & {
  statusCode: number
  original?: Error
  fields?: any
}
export type TonLogger = {
  error: (...args: any[]) => void
  warn: (...args: any[]) => void
  info: (...args: any[]) => void
  debug: (...args: any[]) => void
  verbose: (...args: any[]) => void
}
export type TonMethods =
  | 'get'
  | 'post'
  | 'options'
  | 'del'
  | 'path'
  | 'put'
  | 'head'
  | 'connect'
  | 'trace'
  | 'any'
  | 'ws'
  | 'publish'
// eslint-disable-next-line camelcase, @typescript-eslint/camelcase
export type TonListenSocket = uWS.us_listen_socket
export type TonRoutes = {
  [patter: string]: { methods: TonMethods; handler: TonHandler }
}
export const TonStatusCodes = STATUS_CODES

const ContentType = 'Content-Type'
const TonStatusCodesWithMessage = Object.keys(TonStatusCodes).reduce(
  (pre, curr) => ({
    ...pre,
    [curr]: `${curr} ${TonStatusCodes[curr]}`
  }),
  {}
)
const AbortedMessage = "Can't send anything after response was aborted"

export function create4xxError(
  statusCode: number,
  message: string,
  fields?: any
): TonError {
  const err = new Error(message) as TonError
  err.statusCode = statusCode
  err.fields = fields
  return err
}

export function create5xxError(
  statusCode: number,
  message: string,
  original?: Error
): TonError {
  const err = new Error(message) as TonError
  err.statusCode = statusCode
  err.original = original
  return err
}

export function checkIsNotAborted(res: TonResponse) {
  if (res.aborted) {
    throw create5xxError(500, AbortedMessage)
  }
}

export function writeStatus(res: TonResponse, statusCode: number): void {
  res.statusCode = statusCode || 500
  res.writeStatus(
    TonStatusCodesWithMessage[statusCode] || TonStatusCodesWithMessage[500]
  )
}

export function writeHeaders(res: TonResponse, headers: TonHeaders): void {
  Object.keys(headers).forEach(key => res.writeHeader(key, headers[key]))
}

export function sendEmpty(res: TonResponse, headers: TonHeaders = {}): void {
  checkIsNotAborted(res)
  writeStatus(res, 204)
  writeHeaders(res, headers)
  res.aborted = true
  res.end()
}

export function sendText(
  res: TonResponse,
  statusCode: number,
  data: string,
  headers: TonHeaders = {}
): void {
  checkIsNotAborted(res)

  if (statusCode !== 200) {
    writeStatus(res, statusCode)
  }

  writeHeaders(res, {
    [ContentType]: 'text/plain; charset=utf-8',
    ...headers
  })

  res.aborted = true
  res.end(data)
}

export function sendJSON(
  res: TonResponse,
  statusCode: number,
  data: object,
  headers: TonHeaders = {}
): void {
  checkIsNotAborted(res)

  if (statusCode !== 200) {
    writeStatus(res, statusCode)
  }

  writeHeaders(res, {
    [ContentType]: 'application/json; charset=utf-8',
    ...headers
  })

  res.aborted = true
  res.end(JSON.stringify(data))
}

export function sendError(
  res: TonResponse,
  err: TonError | Error,
  /* istanbul ignore next */
  { logger = tonLogger }: { logger?: TonLogger } = {}
): void {
  try {
    checkIsNotAborted(res)
  } catch (abortedError) {
    logger.error(abortedError)
    return
  }

  const error = err as TonError
  const statusCode = error.statusCode || 500
  const message =
    error.message || TonStatusCodes[statusCode] || TonStatusCodes[500]
  const data = { message }

  if (process.env.NODE_ENV === 'production' && statusCode >= 500) {
    sendJSON(res, statusCode, { message: TonStatusCodes[statusCode] })
  } else {
    sendJSON(res, statusCode, data)
  }

  if (statusCode < 500) {
    return
  }

  if (error.original) {
    logger.error(error.original)
  } else {
    logger.error(error)
  }
}

export function sendStream(
  res: TonResponse,
  statusCode: number,
  data: TonStream,
  headers: TonHeaders = {}
): void {
  checkIsNotAborted(res)

  if (statusCode !== 200) {
    writeStatus(res, statusCode)
  }

  writeHeaders(res, {
    [ContentType]: 'application/octet-stream',
    ...headers
  })

  res.onAborted(() => {
    res.aborted = true
    data.destroy()
  })

  data.on('error', err => {
    sendError(res, err)
    data.destroy()
  })

  data.on('end', () => {
    res.aborted = true
    res.end()
  })

  data.on('data', chunk => {
    const arrayBuffer = chunk.buffer.slice(
      chunk.byteOffset,
      chunk.byteOffset + chunk.byteLength
    )
    const lastOffset = res.getWriteOffset()
    // first try
    const [firstTryOk, firstTryDone] = res.tryEnd(arrayBuffer, data.size)

    if (firstTryDone) {
      data.destroy()
      return
    }

    if (firstTryOk) {
      return
    }

    // pause because backpressure
    data.pause()

    // register async handlers for drainage
    res.onWritable(offset => {
      const [ok, done] = res.tryEnd(
        arrayBuffer.slice(offset - lastOffset),
        data.size
      )

      if (done) {
        res.aborted = true
        data.destroy()
        return ok
      }

      if (ok) {
        data.resume()
      }

      return ok
    })
  })
}

export function redirect(
  res: TonResponse,
  statusCode: 301 | 302,
  location: string
): void {
  checkIsNotAborted(res)
  writeStatus(res, statusCode)
  writeHeaders(res, { Location: location })
  res.aborted = true
  res.end()
}

export function send(
  res: TonResponse,
  statusCode: number,
  data?: TonData | void,
  headers: TonHeaders = {},
  options?: { logger: TonLogger }
): void {
  checkIsNotAborted(res)

  if (statusCode === 204 || typeof data === 'undefined' || data === null) {
    sendEmpty(res, headers)
    return
  }

  if (typeof data === 'string') {
    sendText(res, statusCode, data as string, headers)
    return
  }

  if (data instanceof stream.Readable) {
    sendStream(res, statusCode, data as TonStream, headers)
    return
  }

  if (data instanceof Error) {
    sendError(res, data, options)
    return
  }

  sendJSON(res, statusCode, data as object, headers)
}

const defaultLimitSize = bytes.parse('1mb')

export function readBuffer(
  res: TonResponse,
  { limit = '1mb' } = {}
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let limitSize = defaultLimitSize

    if (limit !== '1mb') {
      limitSize = bytes.parse(limit)
    }

    let data = Buffer.allocUnsafe(0)

    res.onData((chunk, isLast) => {
      data = Buffer.concat([data, Buffer.from(chunk)])

      if (data.length > limitSize) {
        const statusCode = 413
        reject(create4xxError(statusCode, TonStatusCodes[statusCode]))
        return
      }

      if (isLast) {
        resolve(data)
      }
    })
  })
}

export async function readText(
  res: TonResponse,
  { limit = '1mb', encoding = 'utf-8' } = {}
): Promise<string> {
  const body = await readBuffer(res, { limit })
  return body.toString(encoding)
}

export async function readJSON(
  res: TonResponse,
  { limit = '1mb', encoding = 'utf-8' } = {}
): Promise<any> {
  const body = await readText(res, { limit, encoding })
  try {
    return JSON.parse(body)
  } catch (err) {
    throw create4xxError(400, 'Invalid JSON', err)
  }
}

export function handler(fn: TonHandler, options?: { logger: TonLogger }) {
  return async (res: TonResponse, req: TonRequest): Promise<void> => {
    res.aborted = false
    res.onAborted(() => {
      res.aborted = true
    })

    try {
      const result = await fn(req, res)

      if (result === undefined) {
        return
      }

      send(res, res.statusCode || 200, result)
    } catch (err) {
      sendError(res, create5xxError(500, TonStatusCodes[500], err), options)
    }
  }
}

export function route(
  app: TonApp,
  methods: TonMethods,
  pattern: string,
  routeHandler: TonHandler
) {
  app[methods](pattern, handler(routeHandler))
}

export function createRoute(methods: TonMethods) {
  return (app: TonApp, pattern: string, routeHandler: TonHandler) =>
    route(app, methods, pattern, routeHandler)
}

export const any = createRoute('any')
export const connect = createRoute('connect')
export const del = createRoute('del')
export const get = createRoute('get')
export const head = createRoute('head')
export const options = createRoute('options')
export const path = createRoute('path')
export const post = createRoute('post')
export const publish = createRoute('publish')
export const put = createRoute('put')
export const trace = createRoute('trace')
export const ws = createRoute('ws')

export function createApp(opts: TonAppSSLOptions = {}): TonApp {
  if (opts.ssl) {
    /* eslint-disable @typescript-eslint/camelcase */
    return uWS.SSLApp({
      key_file_name: opts.key,
      cert_file_name: opts.cert,
      passphrase: opts.passphrase,
      dh_params_file_name: opts.dhParams,
      ssl_prefer_low_memory_usage: opts.preferLowMemoryUsage
    })
    /* eslint-enable @typescript-eslint/camelcase */
  }
  return uWS.App()
}

export function listen(
  app: TonApp,
  host: string,
  port: number
): Promise<TonListenSocket> {
  return new Promise((resolve, reject) => {
    app.listen(host, port, (token: TonListenSocket) => {
      if (!token) {
        return reject(new Error('missing token'))
      }

      return resolve(token)
    })
  })
}

export function close(token: TonListenSocket) {
  uWS.us_listen_socket_close(token)
}

export function registerGracefulShutdown(
  socket: TonListenSocket,
  /* istanbul ignore next */
  { logger = tonLogger }: { logger?: TonLogger } = {}
) {
  let hasBeenShutdown = false

  function wrapper() {
    if (!hasBeenShutdown) {
      hasBeenShutdown = true
      logger.info('Gracefully shutting down. Please wait...')
      close(socket)
    }
  }

  process.on('SIGINT', wrapper)
  process.on('SIGTERM', wrapper)
  process.on('exit', wrapper)
}
