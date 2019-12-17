const fetch = require("node-fetch");
const wdk = require("wikidata-sdk");

const searchLimit = 500;
const url = `https://en.wiktionary.org/w/api.php?action=query&list=categorymembers&cmtitle=Category%3AEnglish_verbs&cmlimit=${searchLimit}&format=json`;
const irregs = ["ceebs", "cleave", "frain", "giue", "resing", "shend", "shew", "shrive", "talebear", "toshend", "toshake", "toshear"];

async function lexemeExists(search, language = "en") {
  const url = wdk.searchEntities({
    search: search,
    language: language,
    limit: 1,
    format: "json",
    type: "lexeme"
  }) + "&maxlag=5";
  let result;
  try {
    result = await fetch(url);
  } catch (e) {
    console.error("e Unable to check if lexeme exists on Wikidata, retrying in 10 seconds.", e);
    await new Promise((resolve, reject) => setTimeout(resolve, 10000));
    return lexemeExists(search, language);
  }
  const json = await result.json();
  if (!json.search) {
    console.error("no s Unable to check if lexeme exists on Wikidata, retrying in 10 seconds.", json.error.lag);
    await new Promise((resolve, reject) => setTimeout(resolve, 10000));
    return lexemeExists(search, language);
  }
  return json.search.length !== 0;
}

async function getDictLemmaPage(cmcontinue = "") {
  const res = await fetch(url + (cmcontinue ? ("&cmcontinue=" + cmcontinue) : ""));
  let data;
  try {
    data = await res.json();
  } catch (e) {
    console.error(await data.text(), "error");
    return await getDictLemmaPage(cmcontinue);
    //throw new Error("bad body");
  }
  if (data.error) {
    console.error("Unable to search Wiktionary, waiting 15 seconds.");
    await new Promise((resolve, reject) => setTimeout(resolve, 15000));
    return await getDictLemmaPage(cmcontinue);
  }
  return data;
}

function invalidVerb(str) {
  //if (str.includes(":")) return true;
  //if (str.includes(" ")) return true;
  if (!str.match(/^[A-Za-z]*$/)) return true;
  if (irregs.includes(str)) return true;
  return false;
}

async function lemmaCheckLoop(cmcontinue = "", total = 0) {
  var dictData = await getDictLemmaPage(cmcontinue);
  let words = [];
  var promises = [];
  dictData.query.categorymembers.forEach(async (lexeme, i) => {
    setTimeout(async () => {
      if (invalidVerb(lexeme.title)) return;
      let dataCheck = lexemeExists(lexeme.title);
      promises.push(dataCheck);
      dataCheck = await dataCheck;
      total++;
      if (!dataCheck) {
        words.push(lexeme);
        //console.log("checking", lexeme.title);
      }
    }, i * 34);
  });
  await new Promise((resolve, reject) => {setTimeout(resolve, searchLimit * 34);});
  await Promise.all(promises);
  console.error("checked group");
  for (var i = 0; i < words.length; i++) {
    if (invalidVerb(words[i].title)) continue;
    console.log(words[i].title);
    console.error(words[i].title);
  }
  if (total > 3) {
    console.error("total reached");
    //return;
  }
  if (!dictData.continue || !dictData.continue.cmcontinue) {
    console.error("no continue");
    return;
  }
  return lemmaCheckLoop(dictData.continue.cmcontinue, total);
}

lemmaCheckLoop();
