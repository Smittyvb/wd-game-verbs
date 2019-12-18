const express = require("express");
const fs = require("fs");
const fetch = require("node-fetch");
const nlp = require("compromise");
const wdk = require("wikidata-sdk");

const app = express();

let pendingVerbs = fs.readFileSync(__dirname + "/verbs.txt", "utf-8").split("\n").filter(w => w.length >= 2);
let badVerbs = fs.readFileSync(__dirname + "/bad-verbs.txt", "utf-8");
if (badVerbs) badVerbs = badVerbs.split("\n").filter(w => w.length >= 2);

async function saveBadVerbs() {
  fs.writeFile(__dirname + "/bad-verbs.txt", badVerbs.join("\n"), "utf-8", () => {})
}

async function lexemeExists(search, language = "en") {
  const url = wdk.searchEntities({
    search: search,
    language: language,
    limit: 1,
    format: "json",
    type: "lexeme"
  }); // no maxlag
  let result;
  try {
    result = await fetch(url);
  } catch (e) {
    console.log("Unable to check if lexeme exists on Wikidata, retrying in 10 seconds.");
    await new Promise((resolve, reject) => setTimeout(resolve, 10000));
    return lexemeExists(search, language);
  }
  const json = await result.json();
  if (!json.search) {
    console.log("Unable to check if lexeme exists on Wikidata, retrying in 10 seconds.");
    await new Promise((resolve, reject) => setTimeout(resolve, 10000));
    return lexemeExists(search, language);
  }
  return json.search.length !== 0;
}

const sparqlQuery = `
  SELECT ?place ?placeLabel ?addr ?country WHERE {
    ?place wdt:P969 ?addr;
           p:P969 ?addrStatements;
           rdfs:label ?placeLabel;
           wdt:P17 ?country.
    
    MINUS { ?place wdt:P6375 ?newAddr }
    
    FILTER(strlen(str(?addr)) > 10)
    FILTER(lang(?placeLabel) = "en")
  }
  LIMIT 500
`;

let queryResults;

let cachedLangData = {};
let cachedCountryData = {};

async function genTile() {
  if (queryResults.length === 0) return null;
  if (queryResults.length < 100) {
    console.log("fetching more items");
    let newQueryResults = await (await fetch(
      "https://query.wikidata.org/sparql?format=json&query=" + sparqlQuery
    )).json();
    newQueryResults = newQueryResults.results.bindings;
    queryResults = queryResults.concat(newQueryResults);
  }

  let index = Math.floor(Math.random() * queryResults.length);
  let place = queryResults[index];
  queryResults.splice(index, 1);
  if (queryResults.length % 15 === 0) {
    console.log("query results left", queryResults.length);
  }

  const qid = place.place.value.split("entity/")[1];
  const countryQid = place.country.value.split("entity/")[1];

  const entityReq = await fetch(
    `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`,
    {
      headers: {
        "User-Agent": "contact User:SixTwoEight if this is going wrong"
      }
    }
  );
  const entityJson = await entityReq.json();
  if (entityJson.entities[qid].claims["P969"].length > 1) {
    return await genTile();
  }
  if (entityJson.entities[qid].claims["P6375"]) {
    return await genTile();
  }

  let countryLangs;
  if (cachedCountryData[countryQid]) {
    countryLangs = cachedCountryData[countryQid];
  } else {
    const countryReq = await fetch(
      `https://www.wikidata.org/wiki/Special:EntityData/${countryQid}.json`,
      {
        headers: {
          "User-Agent": "contact User:SixTwoEight if this is going wrong"
        }
      }
    );
    const countryJson = await countryReq.json();
    countryLangs = countryJson.entities[countryQid].claims["P37"];
    cachedCountryData[countryQid] = countryLangs;
  }
  const langQids = countryLangs
    .filter(lang => lang.mainsnak.datavalue)
    .map(lang => lang.mainsnak.datavalue.value.id);
  if (
    langQids.length >
    1 /*!((langQids.length === 1) || (langQids.includes("en") && (langQids.length === 2)) || (langQids.includes("en") && langQids.includes("fr")))*/
  )
    return await genTile();
  let controls = [];
  for (let i = 0; i < langQids.length; i++) {
    let langQid = langQids[i];
    let langData;
    if (cachedLangData[langQid]) {
      langData = cachedLangData[langQid];
    } else {
      const langReq = await fetch(
        `https://www.wikidata.org/wiki/Special:EntityData/${langQid}.json`,
        {
          headers: {
            "User-Agent": "contact User:SixTwoEight if this is going wrong"
          }
        }
      );
      const langJson = await langReq.json();
      const langClaims = langJson.entities[langQid].claims;
      langData = [
        langClaims.P305 ? langClaims.P305[0].mainsnak.datavalue.value : "none",
        langJson.entities[langQid].labels.en
          ? langJson.entities[langQid].labels.en.value
          : "none"
      ];
      cachedLangData[langQid] = langData;
    }
    if (langData[0] === "none") continue;
    if (langData[1] === "none") continue;
    // A value needs to be provided when creating a claim with PropertyValueSnak snak.
    controls.push({
      type: "green",
      decision: "yes",
      label: langData[1],
      api_action: {
        action: "wbeditentity",

        entity: qid,
        snaktype: "value",
        property: "P6375",

        value: JSON.stringify({
          text: place.addr.value,
          language: langData[0]
        })
      }
    });
  }

  controls.push({ type: "white", decision: "skip", label: "Skip" });
  controls.push({ type: "blue", decision: "no", label: "None" });

  return {
    id: qid,
    sections: [
      {
        type: "text",
        title: `What language is this address in?`,
        text: place.addr.value
      }
      //{type: "item", q: qid}
    ],
    controls: [
      {
        type: "buttons",
        entries: controls
      }
    ]
  };
}

app.get("/game", async (req, res) => {
  res.contentType("text/javascript");
  if (req.query.action === "desc") {
    res.send(`
      ${req.query.callback}({
        "label":{ "en":"Fix deprecated addresses" },
        "description":{ "en":"Change deprecated string datatype addresses to new, monolingual text ones." },
      })
    `);
  } else if (req.query.action === "tiles") {
    let tiles = [];
    let num = parseInt(req.query.num, 10);
    for (let i = 0; i < num; i++) {
      tiles.push(await genTile());
    }
    res.send(`
      ${req.query.callback}({
        tiles: ${JSON.stringify(tiles)}
      })
    `);
  } else if (req.query.action === "log_action") {
    if (req.query.decision === "no") {
      console.log("rejected", req.query.tile);
    }
    res.send(`
      ${req.query.callback}({});
    `);
  } else {
    res.status(400).send("action not supported");
  }
});

async function genVerbTile() {
  let controls = [];
  
  if (pendingVerbs.length === 0) return;
  
  const randIndex = Math.floor(Math.random() * pendingVerbs.length);
  const verb = pendingVerbs[randIndex];
  pendingVerbs.splice(randIndex, 1);
  
  if (await lexemeExists(verb)) return await genVerbTile();
  
  const infs = nlp(verb).verbs().conjugate()[0];
  if (!infs) {
    console.log("bad verb", verb);
    badVerbs.push(verb);
    saveBadVerbs();
    return await genVerbTile();
  }
  const pastParticiple = infs.Participle || infs.PastTense;
  
  controls.push({
    type: "green",
    decision: "yes",
    label: "Create",
    api_action: {
      // https://phabricator.wikimedia.org/source/tool-lexeme-forms/browse/master/templates.py$1862
      action: "wbeditentity",
      new: "lexeme",
      data: JSON.stringify({
        type: "lexeme",
        language: "Q1860",
        lexicalCategory: "Q24905",
        senses: [],
        lemmas: {
          en: {
            language: "en",
            value: verb
          }
        },
        forms: [
          {
            claims: {},
            add: "",
            grammaticalFeatures: ["Q3910936"],
            representations: {
              en: {"language": "en", "value": infs.Infinitive}
            }
          }, {
            claims: {},
            add: "",
            grammaticalFeatures: ["Q110786", "Q3910936", "Q51929074"],
            representations: {
              en: {"language": "en", "value": infs.PresentTense}
            }
          }, {
            claims: {},
            add: "",
            grammaticalFeatures: ["Q1392475"],
            representations: {
              en: {"language": "en", "value": infs.PastTense}
            }
          }, {
            claims: {},
            add: "",
            grammaticalFeatures: ["Q10345583"],
            representations: {
              en: {"language": "en", "value": infs.Gerund}
            }
          }, {
            claims: {},
            add: "",
            grammaticalFeatures: ["Q1230649"],
            representations: {
              en: {"language": "en", "value": pastParticiple}
            }
          },
        ],
        claims: {},
      }),
    }
  });

  controls.push({ type: "white", decision: "skip", label: "Skip" });
  controls.push({ type: "blue", decision: "no", label: "Incorrect conjugations or not a verb" });
  
  return {
    id: `v1-${verb}`,
    sections: [
      {
        type: "text",
        title: `do these sentences make sense?`,
        text: `\
They ${infs.Infinitive} every day.
He ${infs.PresentTense} every day.
He ${infs.PastTense} every day last week.
They are ${infs.Gerund} right now.
We have ${pastParticiple} for hours.
`
      }
      //{type: "item", q: qid}
    ],
    controls: [
      {
        type: "buttons",
        entries: controls
      }
    ]
  };
}

app.get("/verb-game", async (req, res) => {
  res.contentType("text/javascript");
  if (req.query.action === "desc") {
    res.send(`
      ${req.query.callback}({
        "label":{ "en":"Add verbs from Wiktionary" },
        "description":{ "en":"Wiktionary verb adder. Conjugation is done automatically, please verify it" },
      })
    `);
  } else if (req.query.action === "tiles") {
    let tiles = [];
    let num = parseInt(req.query.num, 10);
    if (num > 50) num = 50;
    for (let i = 0; i < num; i++) {
      const tile = await genVerbTile();
      if (!tile) continue;
      tiles.push(tile);
    }
    res.send(`
      ${req.query.callback}({
        tiles: ${JSON.stringify(tiles)}
      })
    `);
  } else if (req.query.action === "log_action") {
    if (req.query.decision === "no") {
      console.log("rejected", req.query.tile);
      if (req.query.tile.split("-")[1]) {
        badVerbs.push(req.query.tile.split("-")[1]);
        saveBadVerbs();
      }
    }
    res.send(`
      ${req.query.callback}({});
    `);
  } else {
    res.status(400).send("action not supported");
  }
});

app.get("/", (req, res) => {
  res.send(
    `<a href="https://tools.wmflabs.org/wikidata-game/distributed/#mode=test_game&url=https%3A%2F%2Fwd-game-addr.glitch.me%2Fgame">Play</a>`
  );
});

async function main() {
  console.log("fetching items");
  queryResults = await (await fetch(
    "https://query.wikidata.org/sparql?format=json&query=" + sparqlQuery,
    {
      headers: {
        "User-Agent": "contact User:SixTwoEight if this is going wrong"
      }
    }
  )).json();
  queryResults = queryResults.results.bindings;
  const listener = app.listen(process.env.PORT, function() {
    console.log("Your app is listening on port " + listener.address().port);
  });
  genTile();
}
main();