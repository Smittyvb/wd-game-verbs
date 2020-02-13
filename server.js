const express = require("express");
const fs = require("fs");
const fetch = require("node-fetch");
const nlp = require("compromise");
const wdk = require("wikidata-sdk");

const app = express();

let badVerbs = fs.readFileSync(__dirname + "/bad-verbs.txt", "utf-8").split("\n").filter(w => w.length >= 2);
let pendingVerbs = fs.readFileSync(__dirname + "/verbs.txt", "utf-8")
  .split("\n")
  .filter(w => w.length >= 2)
  .filter(v => !badVerbs.includes(v))

console.log(pendingVerbs.length, "pending verbs");

async function saveBadVerbs() {
  fs.writeFile(__dirname + "/bad-verbs.txt", badVerbs.join("\n"), "utf-8", () => {})
}

async function lexemeExists(search, language = "en") {
  const url = wdk.searchEntities({
    search: search,
    language: language,
    limit: 1,
    "continue": 1,
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
  const text = await result.text();
  let json;
  try { json = JSON.parse(text) } catch (e) { console.error("got invalid JSON ", text); process.exit(1); }
  if (!json.search) {
    console.log("Unable to check if lexeme exists on Wikidata, retrying in 10 seconds.");
    await new Promise((resolve, reject) => setTimeout(resolve, 10000));
    return lexemeExists(search, language);
  }
  return json.search.length !== 0;
}


async function genVerbTile() {
  let controls = [];
  
  if (pendingVerbs.length === 0) return;
  
  const randIndex = Math.floor(Math.random() * pendingVerbs.length);
  const verb = pendingVerbs[randIndex];
  pendingVerbs.splice(randIndex, 1);
  
  const infs = nlp(verb).verbs().conjugate()[0];
  if (!infs || (infs.Infinitive !== verb)) {
    console.log("bad verb", verb);
    badVerbs.push(verb);
    saveBadVerbs();
    return await genVerbTile();
  }
  
  const pastParticiple = infs.Participle || infs.PastTense;
  
  /*if (pastParticiple.endsWith("en")) {
    console.log("en", verb);
    badVerbs.push(verb);
    saveBadVerbs();
    return await genVerbTile();
  }*/
  
  if (await lexemeExists(verb)) {
    console.log("exists", verb);
    badVerbs.push(verb);
    saveBadVerbs();
    return await genVerbTile();
  }
  
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

app.get("/verb-import-game", async (req, res) => {
  res.contentType("text/javascript");
  if (req.query.action === "desc") {
    res.send(`
      ${req.query.callback}({
        "label":{ "en":"Add verbs from Wiktionary" },
        "description":{ "en":"Import verbs without a {{en-verb}} template from Wiktionary. (verbs with the template will be able to be imported automatically) Conjugation is done automatically, please verify it." },
        "icon": "https://upload.wikimedia.org/wikipedia/commons/thumb/0/04/Labiodental_flap_%28Gentium%29.svg/120px-Labiodental_flap_%28Gentium%29.svg.png",
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

async function main() {
  const listener = app.listen(process.env.PORT || 5000, function() {
    console.log("Your app is listening on port " + listener.address().port);
  });
}
main();
