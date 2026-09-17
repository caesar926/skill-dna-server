import 'dotenv/config'
import { supabase } from './supabaseClient.js'
import session from 'express-session'
import express from 'express'
import cors from 'cors'
import { calculateScore } from './proofOfWorkScore.js'

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
      pullRequestContributionsByRepository(maxRepositories: 25) {
      repository {
        owner {
          login
        }
      }
      contributions {
        totalCount
      }
     }
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
      stars += repo.stargazerCount || 0
      if (repo.primaryLanguage?.name) {
        languageSet.add(repo.primaryLanguage?.name)
      }
      forks += repo.forkCount
      if (repo.description) {
        descriptions++
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

  const getAISuggestions = async (prompt) => {

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }]
        }),
      }
    )

    const data = await response.json()
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "No suggestions available"

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
  const repoSignals = await getRepoSignals(githubUsername, accessToken)

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

app.get('/api/profile/:username/suggestions', async (req, res) => {
  const userName = req.params.username

  const { data: profile, error: fetchError } = await supabase
    .from('profiles')
    .select('*')
    .eq('github_username', userName)
    .single()

  if (!profile || fetchError) {
    return res.status(404).json({ error: "No profile found" })

  }

  const result = calculateScore(profile)

  const factors = Object.entries(result)
    .filter(([key]) => key !== 'finalScore')
    .map(([key, value]) => ({
      name: key,
      score: value
    })).filter(({ score }) => score < 80);


  const factorContext = {
    activityScore: {
      total_commits: profile.total_commits,
      total_prs: profile.total_prs
    },
    impactScore: {
      total_stars: profile.total_stars,
      followers: profile.data?.followers?.totalCount ?? 0
    },
    breadthScore: {
      totalLanguages: profile.data?.totalLanguages ?? [],
      distinctLanguageCount: profile.data?.totalLanguages?.length ?? 0
    },
    projectQualityScore: {
      forks: profile.data?.totalForks ?? 0,
      descriptionRatio: profile.data?.describedRepoCount / (profile.data?.repositories?.totalCount ?? 1) ?? 0
    },
    openSourceScore: {
      externalPRs: profile.data?.contributionsCollection?.pullRequestContributionsByRepository
        ?.filter(entry => entry.repository.owner.login !== profile.github_username)
        .reduce((sum, entry) => sum + entry.contributions.totalCount, 0) ?? 0
    },
  };

  const weakFactorsWithContext = factors.map(factor => ({
    name: factor.name,
    score: factor.score,
    context: factorContext[factor.name]
  }));

  const prompt = `You are analyzing a developer's GitHub-based profile score on Skill DNA, a platform that scores developers on five factors: coding activity/consistency, community impact, technical breadth, project quality, and open-source contribution.

Below is a list of the factors where this developer scored below 80 out of 100, each with their current score and the raw GitHub signals behind that score.

${JSON.stringify(weakFactorsWithContext)}

For each factor in the list, write exactly one specific, actionable suggestion the developer could act on to improve that score. Base each suggestion strictly on the raw signals provided — do not invent data, assume information you weren't given, or reference factors not in the list. Keep each suggestion to one or two sentences, concrete enough to act on immediately (e.g. "Add a short description to your repositories" rather than "improve your projects").

Respond with ONLY a valid JSON object and nothing else — no markdown code fences, no explanation, no text before or after it. The object must have exactly one key per factor name provided above, using the exact same camelCase spelling (e.g. "projectQualityScore"), and each value must be a single string containing that factor's suggestion.`;
   
  try {
        const text = await getAISuggestions(prompt)
        const suggestions = JSON.parse(text.replace(/```json|```/g, '').trim())
        res.json(suggestions)
      } catch (err) {
        res.status(500).json({ error: "Failed to generate suggestions" })
  
      }
})







