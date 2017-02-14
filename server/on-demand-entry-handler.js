import DynamicEntryPlugin from 'webpack/lib/DynamicEntryPlugin'
import { EventEmitter } from 'events'
import { join } from 'path'
import { parse } from 'url'
import resolvePath from './resolve'

export default function onDemandEntryHandler (devMiddleware, compiler, { dir, dev }) {
  const entries = {}
  let doingEntries = {}
  let completedEntries = {}

  const doneCallbacks = new EventEmitter()

  compiler.plugin('make', function (compilation, done) {
    const allEntries = Object.keys(entries).map((page) => {
      const { name, entry } = entries[page]
      doingEntries[page] = true
      return addEntry(compilation, this.context, name, entry)
    })

    Promise.all(allEntries)
      .then(() => done())
      .catch(done)

    console.log('MAKE')
  })

  compiler.plugin('done', function (stats) {
    // Call all the doneCallbacks
    Object.keys(doingEntries).forEach((page) => {
      entries[page].lastActiveTime = Date.now()
      doneCallbacks.emit(page)
    })

    completedEntries = doingEntries
    doingEntries = {}

    console.log('DONE')
  })

  setInterval(function () {
    const maxInactiveAge = 1000 * 15 // 15 secs
    disposeInactiveEntries(devMiddleware, entries, maxInactiveAge)
  }, 5000)

  return {
    async ensurePage (page) {
      const pagePath = join(dir, 'pages', page)
      const pathname = await resolvePath(pagePath)
      const name = join('bundles', pathname.substring(dir.length))

      const entry = [
        join(__dirname, '..', 'client/webpack-hot-middleware-client'),
        join(__dirname, '..', 'client', 'on-demand-entries-client'),
        `${pathname}?entry`
      ]

      await new Promise((resolve, reject) => {
        if (completedEntries[page]) {
          return resolve()
        }

        if (entries[page]) {
          doneCallbacks.on(page, processCallback)
          return
        }

        entries[page] = { name, entry }
        doneCallbacks.on(page, processCallback)

        devMiddleware.invalidate()

        function processCallback (err) {
          if (err) return reject(err)
          resolve()
        }
      })
    },

    middleware () {
      return function (req, res, next) {
        if (!/^\/on-demand-entries-ping/.test(req.url)) return next()

        const { query } = parse(req.url, true)
        const entry = entries[query.page]

        // If there's an entry
        if (entry) {
          entry.lastActiveTime = Date.now()
          res.status = 200
          res.end('Success')
          return
        }

        // If there's no entry.
        // Then it seems like an weird issue.
        const message = `Client pings but we have no entry for page: ${query.page}`
        console.error(message)
        res.status = 500
        res.end(message)
      }
    }
  }
}

function addEntry (compilation, context, name, entry) {
  return new Promise((resolve, reject) => {
    const dep = DynamicEntryPlugin.createDependency(entry, name)
    compilation.addEntry(context, dep, name, (err) => {
      if (err) return reject(err)
      resolve()
    })
  })
}

function disposeInactiveEntries (devMiddleware, entries, maxAge) {
  let disposedCount = 0

  Object.keys(entries).forEach((page) => {
    const { lastActiveTime } = entries[page]
    if (Date.now() - lastActiveTime > maxAge) {
      console.log('Disposing', page)
      disposedCount++
      delete entries[page]
    }
  })

  if (disposedCount > 0) {
    devMiddleware.invalidate()
  }
}