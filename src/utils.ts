import {Context, Element, h} from 'koishi'
import {Config, Server} from "./index";
import axios, {AxiosResponse} from "axios";


// 将messageList转换为Array<Element | string>  用于session.send
export function paresMessageList(list?: Array<Buffer | string>): Array<Element | string> {
  if (!list) {
    return []
  }
  let messageList = []
  for (let i = 0; i < list.length; i++) {
    parseMessage(list[i])
  }
  function parseMessage(message: Buffer | string) {
    if (typeof message == 'string') {
      messageList.push(message)
    }
    else if (message instanceof Buffer) {
      messageList.push(h.image(message, 'image/png'))
    }
  }
  return messageList
}
export async function serverNameFuzzySearchResult(ctx: Context, config: Config, serverNameText: string): Promise<number> {
  const result = await getFuzzySearchResult(ctx, config, serverNameText);
  if (result && result['server']) {
    return result['server'][0] as number;
  }
  return -1;
}
export async function getFuzzySearchResult(ctx: Context, config: Config, text: string): Promise<object> {
  return await getDataFromBackend(`${config.backendUrl}/fuzzySearch`, {
    text
  }, ctx);
}
export async function getDataFromBackend(url: string, data: Object, ctx: Context): Promise<object> {
  const result = await ctx.http.post(url, data)
  if (result?.data?.status != 'success') {
    return {};
  }
  return result.data.data;
}

export async function commandTopRateRanking(config: Config, mainServer: Server, time: number, compareTier?: number, compareUid? :number): Promise<Array<Buffer | string>> {
  return await getReplyFromBackend(`${config.backendUrl}/topRateRanking`, {
    mainServer,
    time,
    compareTier,
    compareUid,
    compress: true,
  })
}

export async function getReplyFromBackend(url: string, data: any): Promise<Array<Buffer | string>> {
  const result: any = await sendPostRequest(url, data);
  return base64ToList(result)
}

async function sendPostRequest(url: string, data: any): Promise<Object> {
  try {
    const response: AxiosResponse = await axios.post(url, data);
    const result: any = response.data as Object;
    switch (response.status) {
      case 200:
        // 将下载的 JSON 文件转换为对象
        return result;
      case 400:
        return [{
          type: 'string',
          string: `错误: 请求参数错误, 可能因为版本与后端服务器版本不一致`
        }];
      case 404:
        return [{
          type: 'string',
          string: `错误: 无法连接至后端服务器`
        }];
      case 422:
        return [{
          type: 'string',
          string: `错误: 无效的请求 (${result})`
        }];
      case 500:
        return [{
          type: 'string',
          string: `内部错误`
        }];
      default:
        return [{
          type: 'string',
          string: `错误: 未知错误`
        }];
    }
  } catch (error) {
    // 在此处处理错误
    if (axios.isAxiosError(error)) {
      // 处理由 Axios 抛出的错误
      console.error('Axios Error:', error.message);
      return [{
        type: 'string',
        string: '错误: 后端服务器连接出错'
      }];
    } else {
      // 处理其他错误
      console.error('Error:', error.message);
    }
    return [{
      type: 'string',
      string: '内部错误'
    }];
  }
}

function base64ToList(basd64List: Array<{ type: 'string' | 'base64', string: string }>): Array<Buffer | string> {
  const result: Array<Buffer | string> = []
  for (let i = 0; i < basd64List.length; i++) {
    const element = basd64List[i];
    if (element.type == 'string') {
      //result.push(element.string)
      console.log(element.string);
    }
    else if (element.type == 'base64') {
      result.push(Buffer.from(element.string, 'base64'))
    }
  }
  return result
}
export async function readJson(ctx: Context, url: string, retryTimes = 3) {
  do {
    try {
      const json: Promise<JSON> = ctx.http.get(url, {responseType: 'json'});
      return json;
    }catch(err) {
      console.error(err);
    }
  }while (retryTimes-- > 0);
  return undefined;
}
