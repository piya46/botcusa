import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';

function signature(config: Config, id: string, version: number, recipient: string) {
  return createHmac('sha256', config.encryptionKey)
    .update(`line-claim|${config.origin}|${id}|${version}|${recipient}`)
    .digest('base64url');
}
export function claimActionData(config: Config, id: string, version: number, recipient: string) {
  return `claim|${id}|${version}|${signature(config, id, version, recipient)}`;
}
export function readClaimAction(config: Config, data: unknown, recipient: string) {
  if (typeof data !== 'string') return null;
  const match =
    /^claim\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\|(\d{1,9})\|([A-Za-z0-9_-]{43})$/.exec(
      data,
    );
  if (!match) return null;
  const [, id, version, mac] = match;
  if (
    !timingSafeEqual(
      Buffer.from(mac),
      Buffer.from(signature(config, id, Number(version), recipient)),
    )
  )
    return null;
  return { id, version: Number(version) };
}

export function caseFlex(
  config: Config,
  input: {
    id: string;
    number: number;
    version: number;
    recipient: string;
    title?: string;
    accepted?: boolean;
  },
) {
  const number = `#${String(input.number).padStart(4, '0')}`;
  const title = input.title ?? (input.accepted ? 'รับเคสแล้ว' : 'มีเคสรอเจ้าหน้าที่');
  const uri = `${config.origin}/admin/inbox?case=${input.id}`;
  return {
    type: 'flex',
    altText: `${title} ${number}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#F7CF2B',
        paddingAll: '20px',
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text: 'CUSA · MEMBER DESK',
            size: 'xs',
            color: '#514516',
            weight: 'bold',
          },
          { type: 'text', text: title, size: 'xl', weight: 'bold', color: '#252319', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '20px',
        spacing: 'md',
        contents: [
          { type: 'text', text: number, size: 'xxl', weight: 'bold', color: '#252319' },
          {
            type: 'text',
            text: input.accepted
              ? 'คุณเป็นผู้รับผิดชอบเคสนี้แล้ว เปิดเคสเพื่อเริ่มดูแล'
              : 'รอเจ้าหน้าที่รับเรื่อง เปิดเคสเพื่อดูรายละเอียด',
            wrap: true,
            size: 'sm',
            color: '#6E6956',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '16px',
        contents: [
          ...(!input.accepted
            ? [
                {
                  type: 'button',
                  style: 'primary',
                  color: '#78631D',
                  height: 'sm',
                  action: {
                    type: 'postback',
                    label: 'รับเคส',
                    data: claimActionData(config, input.id, input.version, input.recipient),
                  },
                },
              ]
            : []),
          {
            type: 'button',
            style: 'link',
            color: '#78631D',
            height: 'sm',
            action: { type: 'uri', label: 'เปิดเคส', uri },
          },
        ],
      },
    },
  };
}
