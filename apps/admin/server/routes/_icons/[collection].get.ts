export default defineEventHandler(async (event) => {
  const collection = event.context.params?.collection
  if (!collection) return

  // Strip .json if present
  const collectionName = collection.replace(/\.json$/, '')

  // Forward the incoming query string (?icons=...) on the target URL itself:
  // h3's ProxyOptions has no `query` field.
  const search = getRequestURL(event).search
  const target = `https://api.iconify.design/${collectionName}.json${search}`

  return proxyRequest(event, target)
})
