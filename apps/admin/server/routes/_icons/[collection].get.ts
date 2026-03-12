export default defineEventHandler(async (event) => {
  const collection = event.context.params?.collection
  if (!collection) return
  
  // Strip .json if present
  const collectionName = collection.replace(/\.json$/, '')
  
  const query = getQuery(event)
  const target = `https://api.iconify.design/${collectionName}.json`
  
  return proxyRequest(event, target, {
    query
  })
})
