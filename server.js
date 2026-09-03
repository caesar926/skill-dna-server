require('dotenv').config()
const express = require('express')
const app = express()


app.get('/', (req, res) => res.send('server is live'))

app.listen(3001, () =>
  console.log('server running on port 3001'))

app.get('/auth/login', (req, res) => {
  const redirectUrl = `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&scope=read:user&prompt=consent`
  console.log(redirectUrl)
  res.redirect(redirectUrl)
})

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code: code,
    }),
  })
  const tokenData = await tokenResponse.json()
  res.redirect(`http://localhost:5173/#token=${tokenData.access_token}&refresh=${tokenData.refresh_token}`)
})

app.get('/auth/refresh', async (req, res) => {
  const refreshToken = req.query.refresh_token
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })
  const data = await response.json()
  res.json(data)
})