#!/usr/bin/env node

const { Command } = require('commander');
const os = require('os');
const chalk = require('chalk');
const ora = require('ora');
const { existsSync } = require('fs');
const { join, normalize, resolve, dirname } = require('path');
const debug = require('debug')('cnki_crawler');
const { access, stat } = require('fs/promises');
const xlsx = require('xlsx');
const puppeteer = require('puppeteer-core');
const { version = '0.0.1' } = require('./package.json');
const { assert } = require('console');

// construct the argv parser
const program = new Command();
program.version(version);
program
  .option('-d, --debug', 'output extra debugging')
  .option('-l, --headless', 'output extra debugging')
  .option('-o, --output <xlsx_file_path>', 'output xlsx data file', 'output.xlsx');

program.parse(process.argv);

const { debug: verbose, headless, output } = program.opts();

function getChromePath() {
  let browserPath;

  if (os.type() === 'Windows_NT') {
    const programFiles = process.env.PROGRAMFILES;
    browserPath = join(programFiles, 'Google/Chrome/Application/chrome.exe');
  } else if (os.type() === 'Linux') {
    browserPath = '/usr/bin/google-chrome';
  } else if (os.type() === 'Darwin') {
    browserPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }

  if (browserPath && browserPath.length > 0) {
    return normalize(browserPath);
  }

  throw new TypeError(`Cannot run action. ${os.type} is not supported.`);
}

async function oraProcess(title, cb) {
  const spinner = ora({ text: `${title} starting...`, isEnabled: true }).start();
  try {
    await cb();
    spinner.succeed(`${title} finished...`);
    return true;
  } catch (error) {
    console.error(error);
    spinner.fail(`${title} failed...`);
    return false;
  }
}

async function crawler_author_info(topic) {
  let spinner = ora({ text: 'Processing...', isEnabled: true }).stopAndPersist();
  const browser = await puppeteer.launch({
    headless: headless || false,
    executablePath: getChromePath(),
  });
  let [page] = await browser.pages();
  // auto fit the viewport, see https://stackoverflow.com/questions/52553311/how-to-set-max-viewport-in-puppeteer
  page.setViewport({ width: 0, height: 0 });
  await page.setRequestInterception(true);
  // intercept the request
  page.on('request', (request) => {
    const url = new URL(request.url());
    request.continue();
  });
  page.on('error', (err) => {
    console.log('\nError occurred: ', err);
  });
  page.on('pageerror', (pageerr) => {
    console.log('\nPageerror occurred: ', pageerr);
  });
  const results = [];
  // 1. open www.cnki.net
  await oraProcess('open www.cnki.net', async () => {
    await page.goto(`https://www.cnki.net/`, {
      waitUntil: 'networkidle0',
    });
  });
  // 2. search the topic
  await oraProcess('search the topic', async () => {
    await page.type('input#txt_SearchText', topic, { delay: 10 });
    await page.keyboard.press('Enter');
  });
  // 3. change the page_size of the search list results
  await oraProcess('change the page_size of the search list results', async () => {
    const pageSizeSelector = '#perPageDiv > div';
    await page.waitForSelector(pageSizeSelector);
    await page.click(pageSizeSelector);
    // select the 50 page size
    const pageSizeOptions = await page.$$('#perPageDiv > ul > li');
    await pageSizeOptions[2].click()
  });
  // 4. print the page info including total count, pages and so on
  let totalCount, totalPage;
  await oraProcess('print the page info including total count, pages and so on', async () => {
    totalCount = await page.evaluate(() => document.querySelector('#countPageDiv > span.pagerTitleCell > em').textContent);
    // countPageMark is some text like 1/120
    const countPageMark = await page.evaluate(() => document.querySelector('#countPageDiv > span.countPageMark').textContent);
    totalPage = countPageMark.split('/')[1];
    spinner.succeed(`got totalCount: ${totalCount}, totalPage: ${totalPage}`);
  });
  // 5. loop each page and crawle the info and save
  for (let i = 0; i < totalPage; i++) {
    spinner = ora({
      text: `Processing [${i + 1}/${totalPage}] ...`,
      isEnabled: true,
    }).start();
    const parseField = (selector) => {

    };
    const tableBodySelector = '#gridTable > table > tbody > tr'
    await page.waitForSelector(tableBodySelector);
    const recordCount = await page.evaluate(() => document.querySelectorAll('#gridTable > table > tbody > tr').length);
    const recordRows = await page.$$(tableBodySelector);
    // document.querySelector('#gridTable > table > tbody > tr:nth-of-type(1)')
    // document.querySelector('#gridTable > table > tbody > tr:nth-of-type(2)')
    // ...
    // for(let j = 0; j < recordCount; j ++) {
    //   const nameElement = await page.$(`#gridTable > table > tbody > tr:nth-of-type(${j + 1}) > td.name`);
    // }
    for(let recordRow of recordRows) {
      const nameElement = await recordRow.$eval('td.name')
    }
    // get the info of the table list
    // article name and link url
    // author name and link url (optional)
    // source name and link url
    // release date
    // reference count and link url
    // download count and link url
    spinner.succeed(`Processed [${i + 1}/${totalPage}]`);
  }
  // 6. cleanning
  // await browser.close();
  return results;
}

(async () => {
  // check the argv
  if (await existsSync(output)) {
    console.warn(chalk.yellow.bold(`output: ${output} exists already, will overwrite!`));
  }
  try {
    // do the crawler job
    const results = await crawler_author_info('图书情报工作');
    // output the result
    if (verbose) {
      console.info(chalk.blue.bold(`try to write xlsx result file: ${JSON.stringify(results, null, 2)}`));
    }
    // const ws = xlsx.utils.json_to_sheet(results);
    // const wb = xlsx.utils.book_new();
    // xlsx.utils.book_append_sheet(wb, ws);
    // xlsx.writeFile(wb, output);
  } catch (error) {
    console.error(error);
  }
})();
