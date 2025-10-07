// server.js - Backend Express pour l'API Notion
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = 3001;

// Configuration CORS
app.use(cors({
  origin: 'http://localhost:5173'
}));
app.use(express.json());

// Vérifier les variables d'environnement
console.log('🔑 Variables d\'environnement chargées:');
console.log('API Key présente:', !!process.env.VITE_NOTION_API_KEY);
console.log('Agenda DB ID:', process.env.VITE_NOTION_AGENDA_DB_ID);

// Initialiser le client Notion
const { Client } = require('@notionhq/client');
const notion = new Client({
  auth: process.env.VITE_NOTION_API_KEY,
});

// Test de connexion au démarrage
async function testNotionConnection() {
  try {
    console.log('🧪 Test de connexion à Notion...');
    // Test simple : récupérer les infos d'une database
    const response = await notion.databases.retrieve({
      database_id: process.env.VITE_NOTION_AGENDA_DB_ID,
    });
    console.log('✅ Connexion à Notion réussie!');
    console.log('📊 Base de données trouvée:', response.title[0]?.plain_text || 'Sans titre');
  } catch (error) {
    console.error('❌ Erreur de connexion à Notion:', error.message);
    console.error('Vérifiez votre token API et vos IDs de bases de données.');
  }
}

// Route de test
app.get('/api/test', (req, res) => {
  res.json({ 
    message: 'Backend fonctionnel',
    timestamp: new Date().toISOString()
  });
});

// Route pour récupérer les concerts
app.get('/api/concerts', async (req, res) => {
  try {
    console.log('📅 Requête pour récupérer les concerts...');
    
    const response = await notion.databases.query({
      database_id: process.env.VITE_NOTION_AGENDA_DB_ID,
      filter: {
        property: 'Afficher',
        checkbox: {
          equals: true,
        },
      },
      sorts: [
        {
          property: 'Date',
          direction: 'ascending',
        },
      ],
    });

    console.log(`✅ ${response.results.length} concerts trouvés`);

    const concerts = response.results.map((page) => ({
      id: page.id,
      date: page.properties.Date?.date?.start || '',
      title: page.properties.Titre?.title[0]?.plain_text || '',
      location: page.properties.Lieu?.rich_text[0]?.plain_text || '',
	  ville: page.properties.Ville?.rich_text[0]?.plain_text || '',  // NOUVEAU
	  role: page.properties.Role?.rich_text[0]?.plain_text || '',     // NOUVEAU
      description: page.properties.Description?.rich_text[0]?.plain_text || '',
      type: (page.properties.Type?.select?.name || 'concert').toLowerCase(),
      ticketLink: page.properties['Lien billetterie']?.url || undefined,
      display: page.properties.Afficher?.checkbox || false,
    }));

    res.json(concerts);
  } catch (error) {
    console.error('❌ Erreur récupération concerts:', error.message);
    res.status(500).json({ 
      error: 'Erreur serveur',
      message: error.message 
    });
  }
});

// Route pour récupérer les médias
app.get('/api/medias', async (req, res) => {
  try {
    console.log('🎬 Requête pour récupérer les médias...');
    
    const response = await notion.databases.query({
      database_id: process.env.VITE_NOTION_MEDIA_DB_ID,
      sorts: [
        {
          property: 'Ordre',
          direction: 'ascending',
        },
      ],
    });

    console.log(`✅ ${response.results.length} médias trouvés`);

    const medias = response.results.map((page) => ({
      id: page.id,
      title: page.properties.Titre?.title[0]?.plain_text || '',
      type: (page.properties.Type?.select?.name || 'video').toLowerCase(),
      url: page.properties.URL?.url || '',
      description: page.properties.Description?.rich_text[0]?.plain_text || '',
      date: page.properties.Date?.date?.start || '',
      featured: page.properties['Mise en avant']?.checkbox || false,
      order: page.properties.Ordre?.number || 999,
    }));

    res.json(medias);
  } catch (error) {
    console.error('❌ Erreur récupération médias:', error.message);
    res.status(500).json({ 
      error: 'Erreur serveur',
      message: error.message 
    });
  }
});

// Route pour récupérer la presse
app.get('/api/press', async (req, res) => {
  try {
    console.log('📰 Requête pour récupérer la presse...');
    
    const response = await notion.databases.query({
      database_id: process.env.VITE_NOTION_PRESS_DB_ID,
      filter: {
        property: 'Afficher',
        checkbox: {
          equals: true,
        },
      },
      sorts: [
        {
          property: 'Date',
          direction: 'descending',
        },
      ],
    });

    console.log(`✅ ${response.results.length} articles trouvés`);

    const articles = response.results.map((page) => ({
      id: page.id,
      quote: page.properties.Citation?.title[0]?.plain_text || '',
      source: page.properties.Source?.rich_text[0]?.plain_text || '',
      author: page.properties.Auteur?.rich_text[0]?.plain_text || undefined,
      date: page.properties.Date?.date?.start || '',
      articleLink: page.properties['Lien article']?.url || undefined,
      type: (page.properties.Type?.select?.name || 'critique').toLowerCase(),
      display: page.properties.Afficher?.checkbox || false,
    }));

    res.json(articles);
  } catch (error) {
    console.error('❌ Erreur récupération presse:', error.message);
    res.status(500).json({ 
      error: 'Erreur serveur',
      message: error.message 
    });
  }
});

// Route pour récupérer la biographie
app.get('/api/biography', async (req, res) => {
  try {
    console.log('📝 Requête pour récupérer la biographie...');
    
    const response = await notion.blocks.children.list({
      block_id: process.env.VITE_NOTION_BIOGRAPHY_PAGE_ID,
      page_size: 100,
    });

    let html = '';
    for (const block of response.results) {
      if (block.type === 'paragraph') {
        const text = block.paragraph.rich_text
          .map((t) => t.plain_text)
          .join('');
        if (text) html += `<p>${text}</p>`;
      } else if (block.type === 'heading_1') {
        const h1 = block.heading_1.rich_text
          .map((t) => t.plain_text)
          .join('');
        html += `<h1>${h1}</h1>`;
      } else if (block.type === 'heading_2') {
        const h2 = block.heading_2.rich_text
          .map((t) => t.plain_text)
          .join('');
        html += `<h2>${h2}</h2>`;
      }
    }

    console.log('✅ Biographie récupérée');
    res.json({ content: html });
  } catch (error) {
    console.error('❌ Erreur récupération biographie:', error.message);
    res.status(500).json({ 
      error: 'Erreur serveur',
      message: error.message 
    });
  }
});

// Ajouter ces routes dans server.js si elles n'existent pas déjà

// Route pour récupérer le répertoire
app.get('/api/repertoire', async (req, res) => {
  try {
    console.log('🎭 Requête pour récupérer le répertoire...');
    
    const response = await notion.databases.query({
      database_id: process.env.VITE_NOTION_REPERTOIRE_DB_ID,
      sorts: [
        {
          property: 'Compositeur',
          direction: 'ascending',
        },
      ],
    });

    console.log(`✅ ${response.results.length} œuvres trouvées`);

    const repertoire = response.results.map((page) => ({
      id: page.id,
      work: page.properties['Œuvre']?.title[0]?.plain_text || '',
      composer: page.properties.Compositeur?.rich_text[0]?.plain_text || '',
      role: page.properties['Rôle']?.rich_text[0]?.plain_text || '',
      type: page.properties.Type?.select?.name || '',
      year: page.properties['Année(s)']?.rich_text[0]?.plain_text || '',
      venue: page.properties['Lieu(x)']?.rich_text[0]?.plain_text || '',
      language: page.properties.Langue?.select?.name || '',
    }));

    res.json(repertoire);
  } catch (error) {
    console.error('❌ Erreur récupération répertoire:', error.message);
    res.status(500).json({ 
      error: 'Erreur serveur',
      message: error.message 
    });
  }
});

// Route pour récupérer les témoignages
app.get('/api/testimonials', async (req, res) => {
  try {
    console.log('💬 Requête pour récupérer les témoignages...');
    
    const response = await notion.databases.query({
      database_id: process.env.VITE_NOTION_TESTIMONIALS_DB_ID,
      filter: {
        property: 'Afficher',
        checkbox: {
          equals: true,
        },
      },
      sorts: [
        {
          property: 'Date',
          direction: 'descending',
        },
      ],
    });

    console.log(`✅ ${response.results.length} témoignages trouvés`);

    const testimonials = response.results.map((page) => ({
      id: page.id,
      name: page.properties.Nom?.title[0]?.plain_text || '',
      text: page.properties['Témoignage']?.rich_text[0]?.plain_text || '',
      function: page.properties.Fonction?.rich_text[0]?.plain_text || '',
      type: page.properties.Type?.select?.name || '',
      subType: page.properties['Sous-type']?.select?.name || '',
      date: page.properties.Date?.date?.start || '',
      display: page.properties.Afficher?.checkbox || false,
      pages: page.properties.Page?.multi_select?.map((p) => p.name) || [],
    }));

    res.json(testimonials);
  } catch (error) {
    console.error('❌ Erreur récupération témoignages:', error.message);
    res.status(500).json({ 
      error: 'Erreur serveur',
      message: error.message 
    });
  }
});

// Route pour récupérer les services (depuis la page Services)
app.get('/api/services', async (req, res) => {
  try {
    console.log('🎯 Requête pour récupérer les services...');
    
    const response = await notion.blocks.children.list({
      block_id: process.env.VITE_NOTION_SERVICES_PAGE_ID,
      page_size: 100,
    });

    let html = '';
    for (const block of response.results) {
      if (block.type === 'paragraph') {
        const text = block.paragraph.rich_text
          .map((t) => t.plain_text)
          .join('');
        if (text) html += `<p>${text}</p>`;
      } else if (block.type === 'heading_1') {
        const h1 = block.heading_1.rich_text
          .map((t) => t.plain_text)
          .join('');
        html += `<h1>${h1}</h1>`;
      } else if (block.type === 'heading_2') {
        const h2 = block.heading_2.rich_text
          .map((t) => t.plain_text)
          .join('');
        html += `<h2>${h2}</h2>`;
      } else if (block.type === 'heading_3') {
        const h3 = block.heading_3.rich_text
          .map((t) => t.plain_text)
          .join('');
        html += `<h3>${h3}</h3>`;
      } else if (block.type === 'bulleted_list_item') {
        const li = block.bulleted_list_item.rich_text
          .map((t) => t.plain_text)
          .join('');
        html += `<li>${li}</li>`;
      }
    }

    console.log('✅ Services récupérés');
    res.json({ content: html });
  } catch (error) {
    console.error('❌ Erreur récupération services:', error.message);
    res.status(500).json({ 
      error: 'Erreur serveur',
      message: error.message 
    });
  }
});

// Démarrer le serveur
app.listen(PORT, async () => {
  console.log(`✅ Serveur backend démarré sur http://localhost:${PORT}`);
  console.log('📍 Routes disponibles:');
  console.log(`   - http://localhost:${PORT}/api/test`);
  console.log(`   - http://localhost:${PORT}/api/concerts`);
  console.log(`   - http://localhost:${PORT}/api/medias`);
  console.log(`   - http://localhost:${PORT}/api/press`);
  console.log(`   - http://localhost:${PORT}/api/biography`);
  
  // Tester la connexion à Notion
  await testNotionConnection();
});