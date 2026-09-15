import 'dotenv/config'
import { supabase } from './supabaseClient.js'
import session from 'express-session'
import express from 'express'
import cors from 'cors'

const app = express()
app.set('trust proxy', 1)
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 8, // 8 hours, matching GitHub's token lifetime
  },
}))

//supabase client test route
/* app.get('/api/test-db', async (req, res) => {
  const response = await supabase.from('profiles').select('*')
  const { data, error } = response

  if (error) {
    return res.status(500).json({ error: error.message })
  } if (data) {
    return res.json(data)
  }
}
)*/

app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
}))

app.get('/', (req, res) => res.send('server is live'))

app.listen(3001, () =>
  console.log('server running on port 3001'))

app.get('/auth/login', (req, res) => {
  const redirectUrl = `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&scope=read:user&prompt=consent&redirect_uri=${encodeURIComponent(process.env.GITHUB_CALLBACK_URL)}`
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
      redirect_uri: process.env.GITHUB_CALLBACK_URL,
    }),
  })
  const tokenData = await tokenResponse.json()

  req.session.accessToken = tokenData.access_token
  req.session.refreshToken = tokenData.refresh_token

  const userResponse = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  })
  const userData = await userResponse.json()

  req.session.githubUsername = userData.login
  req.session.githubId = userData.id

  res.redirect(process.env.FRONTEND_URL)

  console.log('tokenData:', tokenData)
})

app.get('/auth/me', (req, res) => {
  if (req.session.accessToken) {
    res.json({ loggedIn: true })
  } else {
    res.json({ loggedIn: false })
  }
})

app.get('/auth/refresh', async (req, res) => {
  const refreshToken = req.session.refreshToken
  if (!refreshToken) {
    return res.status(401).json({ error: 'No refresh token in session' })
  }

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

  if (data.error) {
    return res.status(401).json({ error: data.error })
  }

  req.session.accessToken = data.access_token
  req.session.refreshToken = data.refresh_token

  res.json({ refreshed: true })
})

const graphqlQuery = `query($username: String!) {
  user(login: $username) {
    avatarUrl
    bio
    followers {
     totalCount
    }
    repositories(ownerAffiliations: OWNER) { totalCount 
    } 
  
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }

    pinnedItems(first: 6, types: REPOSITORY) {
      nodes {
        ... on Repository {
          id
          name
          description
          stargazerCount
          forkCount
          primaryLanguage { name color }
          url
        }
      }
    }
  }
}`

app.get('/api/graphql', async (req, res) => {
  const accessToken = req.session.accessToken
  if (!accessToken) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: graphqlQuery,
      variables: { username: req.query.username },
    }),
  })

  const data = await response.json()
  res.json(data)
})

const starsQuery = `
query($username: String!, $after: String) {
  user(login: $username) {
    repositories(
      first: 100
      after: $after
      ownerAffiliations: OWNER
    ) {
      nodes {
        stargazerCount
        forkCount
        description
        primaryLanguage { name }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`


async function getRepoSignals(username, accessToken) {
  let total = {}
  let cursor = null
  let hasNextPage = true
  let stars = 0
  let forks = 0
  let descriptions = 0
  const languageSet = new Set()

  while (hasNextPage) {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        query: starsQuery,
        variables: {
          username,
          after: cursor,
        },
      }),
    })

    const data = await response.json()

    if (data.errors) {
  console.error('getRepoSignals GraphQL error:', data.errors)
  return { stars, languages: [...languageSet], forks, descriptions }
}

    const repoData = data.data?.user?.repositories
    const nodes = repoData?.nodes ?? []

    for (const repo of nodes) {
      stars += repo.stargazerCount ||  0
    if (repo.primaryLanguage?.name){
      languageSet.add(repo.primaryLanguage?.name)
    }  
      forks += repo.forkCount
    if (repo.description){
      descriptions ++
    } 
      
    }

    hasNextPage = repoData?.pageInfo?.hasNextPage ?? false
    cursor = repoData?.pageInfo?.endCursor ?? null
  }
      total = {
        stars,
        languages: [...languageSet],
        forks,
        descriptions
      }


  return total
}

app.get('/api/profile/claim', async (req, res) => {
  const { githubUsername, githubId, accessToken } = req.session

  if (!githubUsername || !githubId || !accessToken) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { data: existing, error: fetchError } = await supabase
    .from('profiles')
    .select('*')
    .eq('github_id', githubId)
    .single()

  const ONE_HOUR = 1000 * 60 * 60
  const isFresh =
    existing && Date.now() - new Date(existing.fetched_at).getTime() < ONE_HOUR

  if (isFresh) {
    return res.json(existing)
  }

  const gqlResponse = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: graphqlQuery,
      variables: { username: githubUsername },
    }),
  })
  const gqlResult = await gqlResponse.json()

  if (gqlResult.errors) {
    console.error('Claim route GraphQL error:', gqlResult.errors)
    return res.status(502).json({ error: 'Failed to fetch GitHub data' })
  }

  const userData = gqlResult.data?.user
  const repoSignals = await getRepoSignals (githubUsername, accessToken)

 const row = {
  github_username: githubUsername,
  github_id: githubId,
  total_stars: repoSignals.stars,
  total_commits: userData?.contributionsCollection?.totalCommitContributions || 0,
  total_prs: userData?.contributionsCollection?.totalPullRequestContributions || 0,
  data: {
    ...userData,
    totalForks: repoSignals.forks,
    totalLanguages: repoSignals.languages,
    describedRepoCount: repoSignals.descriptions,
  },
  fetched_at: new Date().toISOString(),
}
console.log(languages)

  const { data: saved, error: saveError } = await supabase
    .from('profiles')
    .upsert(row, { onConflict: 'github_id' })
    .select()
    .single()

  if (saveError) {
    console.error('Supabase upsert error:', saveError)
    return res.status(500).json({ error: 'Failed to save profile' })
  }

  res.json(saved)
})

app.get('/api/profile/:username', async (req, res) => {
  const userName = req.params.username

  const { data: existing, error: fetchErrror } = await supabase
    .from('profiles')
    .select('*')
    .eq('github_username', userName)
    .single()


  if (fetchErrror) {
    return res.status(404).json({ error: "profile not claimed yet" })
  }
  return res.json(existing)


})
