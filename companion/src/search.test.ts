import { describe, expect, test } from "bun:test";
import { findSearchRequest, parseDuckDuckGoLite, stripSearchTags } from "./search.ts";

// Trimmed from a real lite.duckduckgo.com response.
const lite = `
<tr><td>1.&nbsp;</td><td>
  <a rel="nofollow" href="https://www.bbc.com/weather/3936456" class='result-link'>Lima - BBC Weather</a>
</td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>
  <b>Lima</b> weather &amp; forecast, with &quot;hourly&quot; updates&#x27;s view.
</td></tr>
<tr><td>2.&nbsp;</td><td>
  <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fweather.com%2Flima&amp;rut=x" class='result-link'>Lima 10-Day Forecast</a>
</td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>Ten days ahead.</td></tr>
<tr><td>3.&nbsp;</td><td>
  <a rel="nofollow" href="https://duckduckgo.com/y.js?ad_provider=x" class='result-link'>Sponsored</a>
</td></tr>
`;

describe("parseDuckDuckGoLite", () => {
  test("reads titles, snippets and unwrapped URLs, and skips DuckDuckGo's own links", () => {
    expect(parseDuckDuckGoLite(lite)).toEqual([
      { title: "Lima - BBC Weather", url: "https://www.bbc.com/weather/3936456", snippet: `Lima weather & forecast, with "hourly" updates's view.` },
      { title: "Lima 10-Day Forecast", url: "https://weather.com/lima", snippet: "Ten days ahead." },
    ]);
  });
});

describe("findSearchRequest", () => {
  test.each([
    ["[search: weather in Lima today]", "weather in Lima today"],
    ["[buscar: precio del dólar]", "precio del dólar"],
    ['<think>maybe [search: no]</think> [Search: "new Zelda release date"]', "new Zelda release date"],
    ["[happy] Of course!", null],
  ])("%s", (reply, query) => {
    expect(findSearchRequest(reply)).toBe(query);
  });

  test("stripSearchTags leaves the rest of the reply", () => {
    expect(stripSearchTags("[feliz] Ya busqué. [buscar: algo]").trim()).toBe("[feliz] Ya busqué.");
  });
});
