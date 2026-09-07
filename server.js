import 'dotenv/config'
import session from 'express-session'
import express from 'express'
import cors from 'cors'
const app = express()

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8, // 8 hours, matching GitHub's token lifetime
  },
}))

app.use(cors({
  origin: 'https://skill-dna-kappa.vercel.app',
  credentials: true,
}))
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

  req.session.accessToken = tokenData.access_token
  req.session.refreshToken = tokenData.refresh_token

  res.redirect('https://skill-dna-kappa.vercel.app/')
})

app.get('/auth/me', (req, res) => {
  if (req.session.accessToken) {
    res.json({ loggedIn :true })
  } else {
    res.json({ loggedIn:false })
  }
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
