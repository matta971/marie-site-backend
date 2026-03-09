// worker.js - Cloudflare Worker pour l'API Notion + Chatbot Admin
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const jsonResponse = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    try {
      // ==================== ROUTES GET (existantes) ====================
      if (url.pathname === '/api/concerts' && request.method === 'GET') {
        return jsonResponse(await getConcerts(env));
      }
      if (url.pathname === '/api/medias' && request.method === 'GET') {
        return jsonResponse(await getMedias(env));
      }
      if (url.pathname === '/api/press' && request.method === 'GET') {
        return jsonResponse(await getPressArticles(env));
      }
      if (url.pathname === '/api/repertoire' && request.method === 'GET') {
        return jsonResponse(await getRepertoire(env));
      }
      if (url.pathname === '/api/biography' && request.method === 'GET') {
        return jsonResponse(await getBiography(env));
      }
      if (url.pathname === '/api/testimonials' && request.method === 'GET') {
        return jsonResponse(await getTestimonials(env));
      }

      // ==================== ROUTE TRANSLATE ====================
      if (url.pathname === '/api/translate' && request.method === 'POST') {
        const { text, lang } = await request.json();
        if (!text || !lang) {
          return jsonResponse({ error: 'text et lang requis' }, 400);
        }
        if (lang === 'fr') {
          return jsonResponse({ translated: text });
        }
        const result = await translateWithCache(text, lang, env);
        return jsonResponse(result);
      }

      // ==================== ROUTE CHAT ====================
      if (url.pathname === '/api/chat' && request.method === 'POST') {
        const authHeader = request.headers.get('Authorization');
        if (authHeader !== `Bearer ${env.ADMIN_PASSWORD}`) {
          return jsonResponse({ error: 'Non autorisé' }, 401);
        }

        const { messages } = await request.json();
        if (!messages || !Array.isArray(messages)) {
          return jsonResponse({ error: 'Messages requis' }, 400);
        }

        const reply = await handleChat(messages, env);
        return jsonResponse(reply);
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      return jsonResponse({ error: error.message }, 500);
    }
  },
};

// ==================== CHAT AVEC CLAUDE ====================

const SYSTEM_PROMPT = `Tu es l'assistant personnel de Marie Emeraude, artiste lyrique (mezzo-soprano).
Tu l'aides à gérer le contenu de son site web via ses bases de données Notion.

Tu peux :
- AJOUTER un concert, une critique de presse, un média, une œuvre au répertoire, ou un témoignage
- MODIFIER une entrée existante (il faut d'abord lister les entrées pour trouver l'ID)
- SUPPRIMER une entrée existante (il faut d'abord lister les entrées pour trouver l'ID)
- LISTER les entrées existantes d'une catégorie

Quand Marie te donne des informations, pose les questions nécessaires pour compléter les champs requis.
Sois concis, chaleureux et professionnel. Parle en français.

Pour modifier ou supprimer, commence TOUJOURS par lister les entrées avec list_entries pour identifier celle concernée.
Quand tu as toutes les informations, récapitule et demande confirmation avant d'agir.

Champs par type :
- Concert : titre (requis), date (requis, format YYYY-MM-DD), lieu, ville, rôle, description, type (concert/recital/opera/masterclass), lien billetterie
- Presse : citation (requis), source (requis), auteur, date, lien article, type (critique/interview/mention)
- Média : titre (requis), type (video/audio/photo, requis), url (requis), description, date, ordre (numéro)
- Répertoire : œuvre (requis), compositeur (requis), rôle, type (opera/oratorio/melodie/sacred), année(s), lieu(x), langue
- Témoignage : nom (requis), témoignage (requis), fonction, type (student/colleague/organizer), date, pages (accueil/enseignement)`;

const TOOLS = [
  // ==================== LISTER ====================
  {
    name: 'list_entries',
    description: 'Lister les entrées existantes d\'une catégorie pour voir, modifier ou supprimer',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['concerts', 'press', 'medias', 'repertoire', 'testimonials'],
          description: 'Catégorie à lister',
        },
      },
      required: ['category'],
    },
  },
  // ==================== CRÉER ====================
  {
    name: 'create_concert',
    description: "Ajouter un concert ou événement à l'agenda",
    input_schema: {
      type: 'object',
      properties: {
        titre: { type: 'string', description: 'Titre du concert/programme' },
        date: { type: 'string', description: 'Date au format YYYY-MM-DD' },
        lieu: { type: 'string', description: 'Nom de la salle ou du lieu' },
        ville: { type: 'string', description: 'Ville' },
        role: { type: 'string', description: 'Rôle interprété par Marie' },
        description: { type: 'string', description: 'Description du concert' },
        type: { type: 'string', enum: ['concert', 'recital', 'opera', 'masterclass'], description: "Type d'événement" },
        ticketLink: { type: 'string', description: 'URL de la billetterie' },
      },
      required: ['titre', 'date'],
    },
  },
  {
    name: 'create_press',
    description: 'Ajouter une critique ou article de presse',
    input_schema: {
      type: 'object',
      properties: {
        citation: { type: 'string', description: 'Citation ou extrait de la critique' },
        source: { type: 'string', description: 'Nom du média (Le Monde, Diapason, etc.)' },
        auteur: { type: 'string', description: "Nom de l'auteur de l'article" },
        date: { type: 'string', description: 'Date au format YYYY-MM-DD' },
        articleLink: { type: 'string', description: "URL de l'article" },
        type: { type: 'string', enum: ['critique', 'interview', 'mention'], description: "Type d'article" },
      },
      required: ['citation', 'source'],
    },
  },
  {
    name: 'create_media',
    description: 'Ajouter un média (vidéo, audio ou photo)',
    input_schema: {
      type: 'object',
      properties: {
        titre: { type: 'string', description: 'Titre du média' },
        type: { type: 'string', enum: ['video', 'audio', 'photo'], description: 'Type de média' },
        url: { type: 'string', description: 'URL du média (YouTube, SoundCloud, etc.)' },
        description: { type: 'string', description: 'Description du média' },
        date: { type: 'string', description: 'Date au format YYYY-MM-DD' },
        ordre: { type: 'number', description: "Ordre d'affichage" },
      },
      required: ['titre', 'type', 'url'],
    },
  },
  {
    name: 'create_repertoire',
    description: 'Ajouter une œuvre au répertoire',
    input_schema: {
      type: 'object',
      properties: {
        oeuvre: { type: 'string', description: "Nom de l'œuvre" },
        compositeur: { type: 'string', description: 'Nom du compositeur' },
        role: { type: 'string', description: 'Rôle interprété' },
        type: { type: 'string', enum: ['opera', 'oratorio', 'melodie', 'sacred'], description: "Type d'œuvre" },
        annees: { type: 'string', description: "Année(s) d'interprétation" },
        lieux: { type: 'string', description: 'Lieu(x) de représentation' },
        langue: { type: 'string', description: "Langue de l'œuvre" },
      },
      required: ['oeuvre', 'compositeur'],
    },
  },
  {
    name: 'create_testimonial',
    description: 'Ajouter un témoignage',
    input_schema: {
      type: 'object',
      properties: {
        nom: { type: 'string', description: 'Nom de la personne' },
        temoignage: { type: 'string', description: 'Texte du témoignage' },
        fonction: { type: 'string', description: 'Fonction de la personne (ex: Directeur artistique)' },
        type: { type: 'string', enum: ['student', 'colleague', 'organizer'], description: 'Type de témoignage' },
        date: { type: 'string', description: 'Date au format YYYY-MM-DD' },
        pages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Pages où afficher le témoignage (ex: ["accueil", "enseignement"])',
        },
      },
      required: ['nom', 'temoignage'],
    },
  },
  // ==================== MODIFIER ====================
  {
    name: 'update_concert',
    description: "Modifier un concert existant (fournir l'ID + les champs à modifier)",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID Notion de la page à modifier' },
        titre: { type: 'string' },
        date: { type: 'string' },
        lieu: { type: 'string' },
        ville: { type: 'string' },
        role: { type: 'string' },
        description: { type: 'string' },
        type: { type: 'string', enum: ['concert', 'recital', 'opera', 'masterclass'] },
        ticketLink: { type: 'string' },
        afficher: { type: 'boolean', description: 'Afficher ou masquer sur le site' },
      },
      required: ['id'],
    },
  },
  {
    name: 'update_press',
    description: "Modifier une critique de presse existante",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID Notion de la page à modifier' },
        citation: { type: 'string' },
        source: { type: 'string' },
        auteur: { type: 'string' },
        date: { type: 'string' },
        articleLink: { type: 'string' },
        type: { type: 'string', enum: ['critique', 'interview', 'mention'] },
        afficher: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'update_media',
    description: "Modifier un média existant",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID Notion de la page à modifier' },
        titre: { type: 'string' },
        type: { type: 'string', enum: ['video', 'audio', 'photo'] },
        url: { type: 'string' },
        description: { type: 'string' },
        date: { type: 'string' },
        ordre: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'update_repertoire',
    description: "Modifier une œuvre du répertoire existante",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID Notion de la page à modifier' },
        oeuvre: { type: 'string' },
        compositeur: { type: 'string' },
        role: { type: 'string' },
        type: { type: 'string', enum: ['opera', 'oratorio', 'melodie', 'sacred'] },
        annees: { type: 'string' },
        lieux: { type: 'string' },
        langue: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'update_testimonial',
    description: "Modifier un témoignage existant",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID Notion de la page à modifier' },
        nom: { type: 'string' },
        temoignage: { type: 'string' },
        fonction: { type: 'string' },
        type: { type: 'string', enum: ['student', 'colleague', 'organizer'] },
        date: { type: 'string' },
        pages: { type: 'array', items: { type: 'string' } },
        afficher: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  // ==================== SUPPRIMER ====================
  {
    name: 'delete_entry',
    description: "Supprimer (archiver) une entrée Notion par son ID",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID Notion de la page à supprimer' },
      },
      required: ['id'],
    },
  },
];

async function handleChat(messages, env) {
  let claudeResponse = await callClaude(messages, env);
  const allMessages = [...messages];

  while (claudeResponse.stop_reason === 'tool_use') {
    allMessages.push({ role: 'assistant', content: claudeResponse.content });

    const toolResults = [];
    for (const block of claudeResponse.content) {
      if (block.type === 'tool_use') {
        const result = await executeNotionTool(block.name, block.input, env);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
    }

    allMessages.push({ role: 'user', content: toolResults });
    claudeResponse = await callClaude(allMessages, env);
  }

  const textBlocks = claudeResponse.content.filter((b) => b.type === 'text');
  return {
    reply: textBlocks.map((b) => b.text).join('\n'),
  };
}

async function callClaude(messages, env) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${err}`);
  }

  return response.json();
}

// ==================== EXÉCUTION DES OUTILS NOTION ====================

async function executeNotionTool(toolName, input, env) {
  const notionHeaders = {
    'Authorization': `Bearer ${env.NOTION_API_KEY}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  try {
    // ---- LISTER ----
    if (toolName === 'list_entries') {
      return await listEntries(input.category, env);
    }

    // ---- SUPPRIMER ----
    if (toolName === 'delete_entry') {
      return await deleteNotionPage(input.id, notionHeaders);
    }

    // ---- CRÉER ----
    switch (toolName) {
      case 'create_concert':
        return await createNotionPage(env.NOTION_AGENDA_DB_ID, buildConcertProps(input), notionHeaders);
      case 'create_press':
        return await createNotionPage(env.NOTION_PRESS_DB_ID, buildPressProps(input), notionHeaders);
      case 'create_media':
        return await createNotionPage(env.NOTION_MEDIA_DB_ID, buildMediaProps(input), notionHeaders);
      case 'create_repertoire':
        return await createNotionPage(env.NOTION_REPERTOIRE_DB_ID, buildRepertoireProps(input), notionHeaders);
      case 'create_testimonial':
        return await createNotionPage(env.NOTION_TESTIMONIALS_DB_ID, buildTestimonialProps(input), notionHeaders);

      // ---- MODIFIER ----
      case 'update_concert':
        return await updateNotionPage(input.id, buildConcertProps(input), notionHeaders);
      case 'update_press':
        return await updateNotionPage(input.id, buildPressProps(input), notionHeaders);
      case 'update_media':
        return await updateNotionPage(input.id, buildMediaProps(input), notionHeaders);
      case 'update_repertoire':
        return await updateNotionPage(input.id, buildRepertoireProps(input), notionHeaders);
      case 'update_testimonial':
        return await updateNotionPage(input.id, buildTestimonialProps(input), notionHeaders);

      default:
        return { success: false, error: `Outil inconnu: ${toolName}` };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== BUILDERS DE PROPRIÉTÉS ====================

function buildConcertProps(input) {
  return {
    ...(input.titre && { 'Titre': { title: [{ text: { content: input.titre } }] } }),
    ...(input.date && { 'Date': { date: { start: input.date } } }),
    ...(input.lieu && { 'Lieu': { rich_text: [{ text: { content: input.lieu } }] } }),
    ...(input.ville && { 'Ville': { rich_text: [{ text: { content: input.ville } }] } }),
    ...(input.role && { 'Role': { rich_text: [{ text: { content: input.role } }] } }),
    ...(input.description && { 'Description': { rich_text: [{ text: { content: input.description } }] } }),
    ...(input.type && { 'Type': { select: { name: input.type } } }),
    ...(input.ticketLink && { 'Lien billetterie': { url: input.ticketLink } }),
    ...(input.afficher !== undefined && { 'Afficher': { checkbox: input.afficher } }),
    // Pour la création, activer Afficher par défaut
    ...(!input.id && input.afficher === undefined && { 'Afficher': { checkbox: true } }),
  };
}

function buildPressProps(input) {
  return {
    ...(input.citation && { 'Citation': { title: [{ text: { content: input.citation } }] } }),
    ...(input.source && { 'Source': { rich_text: [{ text: { content: input.source } }] } }),
    ...(input.auteur && { 'Auteur': { rich_text: [{ text: { content: input.auteur } }] } }),
    ...(input.date && { 'Date': { date: { start: input.date } } }),
    ...(input.articleLink && { 'Lien article': { url: input.articleLink } }),
    ...(input.type && { 'Type': { select: { name: input.type } } }),
    ...(input.afficher !== undefined && { 'Afficher': { checkbox: input.afficher } }),
    ...(!input.id && input.afficher === undefined && { 'Afficher': { checkbox: true } }),
  };
}

function buildMediaProps(input) {
  return {
    ...(input.titre && { 'Titre': { title: [{ text: { content: input.titre } }] } }),
    ...(input.type && { 'Type': { select: { name: input.type } } }),
    ...(input.url && { 'URL': { url: input.url } }),
    ...(input.description && { 'Description': { rich_text: [{ text: { content: input.description } }] } }),
    ...(input.date && { 'Date': { date: { start: input.date } } }),
    ...(input.ordre && { 'Ordre': { number: input.ordre } }),
  };
}

function buildRepertoireProps(input) {
  return {
    ...(input.oeuvre && { 'Œuvre': { title: [{ text: { content: input.oeuvre } }] } }),
    ...(input.compositeur && { 'Compositeur': { rich_text: [{ text: { content: input.compositeur } }] } }),
    ...(input.role && { 'Rôle': { rich_text: [{ text: { content: input.role } }] } }),
    ...(input.type && { 'Type': { select: { name: input.type } } }),
    ...(input.annees && { 'Année(s)': { rich_text: [{ text: { content: input.annees } }] } }),
    ...(input.lieux && { 'Lieu(x)': { rich_text: [{ text: { content: input.lieux } }] } }),
    ...(input.langue && { 'Langue': { select: { name: input.langue } } }),
  };
}

function buildTestimonialProps(input) {
  return {
    ...(input.nom && { 'Nom': { title: [{ text: { content: input.nom } }] } }),
    ...(input.temoignage && { 'Témoignage': { rich_text: [{ text: { content: input.temoignage } }] } }),
    ...(input.fonction && { 'Fonction': { rich_text: [{ text: { content: input.fonction } }] } }),
    ...(input.type && { 'Type': { select: { name: input.type } } }),
    ...(input.date && { 'Date': { date: { start: input.date } } }),
    ...(input.pages && { 'Page': { multi_select: input.pages.map((p) => ({ name: p })) } }),
    ...(input.afficher !== undefined && { 'Afficher': { checkbox: input.afficher } }),
    ...(!input.id && input.afficher === undefined && { 'Afficher': { checkbox: true } }),
  };
}

// ==================== OPÉRATIONS NOTION ====================

async function listEntries(category, env) {
  const dbMap = {
    concerts: env.NOTION_AGENDA_DB_ID,
    press: env.NOTION_PRESS_DB_ID,
    medias: env.NOTION_MEDIA_DB_ID,
    repertoire: env.NOTION_REPERTOIRE_DB_ID,
    testimonials: env.NOTION_TESTIMONIALS_DB_ID,
  };

  const dbId = dbMap[category];
  if (!dbId) return { success: false, error: `Catégorie inconnue: ${category}` };

  const response = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });

  const data = await response.json();

  // Formater selon la catégorie pour que Claude puisse lire facilement
  const entries = data.results.map((page) => {
    const base = { id: page.id };
    switch (category) {
      case 'concerts':
        return {
          ...base,
          titre: page.properties.Titre?.title[0]?.plain_text || '',
          date: page.properties.Date?.date?.start || '',
          lieu: page.properties.Lieu?.rich_text[0]?.plain_text || '',
          ville: page.properties.Ville?.rich_text[0]?.plain_text || '',
          role: page.properties.Role?.rich_text[0]?.plain_text || '',
          type: page.properties.Type?.select?.name || '',
          afficher: page.properties.Afficher?.checkbox || false,
        };
      case 'press':
        return {
          ...base,
          citation: page.properties.Citation?.title[0]?.plain_text || '',
          source: page.properties.Source?.rich_text[0]?.plain_text || '',
          auteur: page.properties.Auteur?.rich_text[0]?.plain_text || '',
          date: page.properties.Date?.date?.start || '',
          type: page.properties.Type?.select?.name || '',
          afficher: page.properties.Afficher?.checkbox || false,
        };
      case 'medias':
        return {
          ...base,
          titre: page.properties.Titre?.title[0]?.plain_text || '',
          type: page.properties.Type?.select?.name || '',
          url: page.properties.URL?.url || '',
          date: page.properties.Date?.date?.start || '',
          ordre: page.properties.Ordre?.number || 0,
        };
      case 'repertoire':
        return {
          ...base,
          oeuvre: page.properties['Œuvre']?.title[0]?.plain_text || '',
          compositeur: page.properties.Compositeur?.rich_text[0]?.plain_text || '',
          role: page.properties['Rôle']?.rich_text[0]?.plain_text || '',
          type: page.properties.Type?.select?.name || '',
        };
      case 'testimonials':
        return {
          ...base,
          nom: page.properties.Nom?.title[0]?.plain_text || '',
          temoignage: (page.properties['Témoignage']?.rich_text[0]?.plain_text || '').substring(0, 80),
          fonction: page.properties.Fonction?.rich_text[0]?.plain_text || '',
          type: page.properties.Type?.select?.name || '',
          afficher: page.properties.Afficher?.checkbox || false,
        };
      default:
        return base;
    }
  });

  return { success: true, count: entries.length, entries };
}

async function createNotionPage(databaseId, properties, headers) {
  const response = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Notion API error: ${response.status} - ${err}`);
  }

  const page = await response.json();
  return { success: true, pageId: page.id };
}

async function updateNotionPage(pageId, properties, headers) {
  const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ properties }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Notion API error: ${response.status} - ${err}`);
  }

  return { success: true, pageId };
}

async function deleteNotionPage(pageId, headers) {
  const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ archived: true }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Notion API error: ${response.status} - ${err}`);
  }

  return { success: true, pageId, archived: true };
}

// ==================== FONCTIONS GET (pour les routes publiques) ====================

async function getConcerts(env) {
  const response = await fetch(`https://api.notion.com/v1/databases/${env.NOTION_AGENDA_DB_ID}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: { property: 'Afficher', checkbox: { equals: true } },
      sorts: [{ property: 'Date', direction: 'ascending' }],
    }),
  });

  const data = await response.json();
  return data.results.map((page) => ({
    id: page.id,
    date: page.properties.Date?.date?.start || '',
    title: page.properties.Titre?.title[0]?.plain_text || '',
    location: page.properties.Lieu?.rich_text[0]?.plain_text || '',
    ville: page.properties.Ville?.rich_text[0]?.plain_text || '',
    role: page.properties.Role?.rich_text[0]?.plain_text || '',
    description: page.properties.Description?.rich_text[0]?.plain_text || '',
    type: (page.properties.Type?.select?.name || 'concert').toLowerCase(),
    ticketLink: page.properties['Lien billetterie']?.url || undefined,
    display: page.properties.Afficher?.checkbox || false,
  }));
}

async function getMedias(env) {
  const response = await fetch(`https://api.notion.com/v1/databases/${env.NOTION_MEDIA_DB_ID}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sorts: [{ property: 'Ordre', direction: 'ascending' }],
    }),
  });

  const data = await response.json();
  return data.results.map((page) => ({
    id: page.id,
    title: page.properties.Titre?.title[0]?.plain_text || '',
    type: (page.properties.Type?.select?.name || 'video').toLowerCase(),
    category: page.properties['Catégorie']?.select?.name || '',
    url: page.properties.URL?.url || '',
    description: page.properties.Description?.rich_text[0]?.plain_text || '',
    date: page.properties.Date?.date?.start || '',
    location: page.properties.Lieu?.rich_text[0]?.plain_text || '',
    featured: page.properties['Mise en avant']?.checkbox || false,
    order: page.properties.Ordre?.number || 999,
  }));
}

async function getPressArticles(env) {
  const response = await fetch(`https://api.notion.com/v1/databases/${env.NOTION_PRESS_DB_ID}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: { property: 'Afficher', checkbox: { equals: true } },
      sorts: [{ property: 'Date', direction: 'descending' }],
    }),
  });

  const data = await response.json();
  return data.results.map((page) => ({
    id: page.id,
    quote: page.properties.Citation?.title[0]?.plain_text || '',
    source: page.properties.Source?.rich_text[0]?.plain_text || '',
    author: page.properties.Auteur?.rich_text[0]?.plain_text || undefined,
    date: page.properties.Date?.date?.start || '',
    articleLink: page.properties['Lien article']?.url || undefined,
    type: (page.properties.Type?.select?.name || 'critique').toLowerCase(),
    display: page.properties.Afficher?.checkbox || false,
  }));
}

async function getRepertoire(env) {
  const response = await fetch(`https://api.notion.com/v1/databases/${env.NOTION_REPERTOIRE_DB_ID}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sorts: [
        { property: 'Année(s)', direction: 'descending' },
        { property: 'Œuvre', direction: 'ascending' },
      ],
    }),
  });

  const data = await response.json();
  return data.results.map((page) => ({
    id: page.id,
    work: page.properties['Œuvre']?.title[0]?.plain_text || '',
    composer: page.properties.Compositeur?.rich_text[0]?.plain_text || '',
    role: page.properties['Rôle']?.rich_text[0]?.plain_text || '',
    type: (page.properties.Type?.select?.name || '').toLowerCase(),
    year: page.properties['Année(s)']?.rich_text[0]?.plain_text || '',
    venue: page.properties['Lieu(x)']?.rich_text[0]?.plain_text || '',
    language: page.properties.Langue?.select?.name || '',
  }));
}

async function getTestimonials(env) {
  const response = await fetch(`https://api.notion.com/v1/databases/${env.NOTION_TESTIMONIALS_DB_ID}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: { property: 'Afficher', checkbox: { equals: true } },
      sorts: [{ property: 'Date', direction: 'descending' }],
    }),
  });

  const data = await response.json();
  return data.results.map((page) => ({
    id: page.id,
    name: page.properties.Nom?.title[0]?.plain_text || '',
    text: page.properties['Témoignage']?.rich_text[0]?.plain_text || '',
    function: page.properties.Fonction?.rich_text[0]?.plain_text || '',
    type: page.properties.Type?.select?.name || '',
    date: page.properties.Date?.date?.start || '',
    display: page.properties.Afficher?.checkbox || false,
    pages: page.properties.Page?.multi_select?.map((p) => p.name) || [],
  }));
}

// ==================== TRADUCTION AVEC CACHE KV ====================

async function translateWithCache(text, targetLang, env) {
  const langMap = {
    en: 'en-GB',
    de: 'de-DE',
    it: 'it-IT',
    es: 'es-ES',
    fr: 'fr-FR',
    pt: 'pt-BR',
    ru: 'ru-RU',
  };
  const to = langMap[targetLang] || targetLang;

  // Generate cache key (simple hash)
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  const cacheKey = `${targetLang}_${hash}`;

  // Check KV cache
  const cached = await env.TRANSLATIONS.get(cacheKey);
  if (cached) {
    return { translated: cached, cached: true };
  }

  // Split into chunks if needed (MyMemory limit ~500 chars)
  const MAX_CHUNK = 450;
  const chunks = splitIntoChunks(text, MAX_CHUNK);
  const translatedChunks = [];

  for (const chunk of chunks) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=fr-FR|${to}`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data.responseStatus === 200 && data.responseData?.translatedText) {
          translatedChunks.push(data.responseData.translatedText);
        } else {
          translatedChunks.push(chunk);
        }
      } else {
        translatedChunks.push(chunk);
      }
    } catch {
      translatedChunks.push(chunk);
    }
  }

  const translated = translatedChunks.join(' ');

  // Store in KV (TTL 30 days)
  await env.TRANSLATIONS.put(cacheKey, translated, { expirationTtl: 2592000 });

  return { translated, cached: false };
}

function splitIntoChunks(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  const parts = text.split(/(?<=[.!?])\s+|(?=<\/p>)|(?=<br)/);
  let current = '';

  for (const part of parts) {
    if ((current + part).length > maxLen && current.length > 0) {
      chunks.push(current.trim());
      current = part;
    } else {
      current += (current ? ' ' : '') + part;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

async function getBiography(env) {
  const response = await fetch(`https://api.notion.com/v1/blocks/${env.NOTION_BIOGRAPHY_PAGE_ID}/children`, {
    headers: {
      'Authorization': `Bearer ${env.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
    },
  });

  const data = await response.json();
  return { blocks: data.results };
}
