// Official purpose order and park order, verified 2026-10-10.
export const parkGroups = [
  {
    surface: 'hard',
    label: 'ハード',
    parks: [
      {
        parkId: '1310',
        parkName: '大井ふ頭海浜公園Ａ',
      },
      {
        parkId: '1315',
        parkName: '大井ふ頭海浜公園Ｂ',
      },
      {
        parkId: '1350',
        parkName: '有明テニスＡ屋外ハードコート',
      },
      {
        parkId: '1370',
        parkName: '有明テニスＢインドアコート',
      },
    ],
  },
  {
    surface: 'grass',
    label: '人工芝',
    parks: [
      {
        parkId: '1000',
        parkName: '日比谷公園',
      },
      {
        parkId: '1010',
        parkName: '芝公園',
      },
      {
        parkId: '1040',
        parkName: '猿江恩賜公園',
      },
      {
        parkId: '1050',
        parkName: '亀戸中央公園',
      },
      {
        parkId: '1060',
        parkName: '木場公園',
      },
      {
        parkId: '1070',
        parkName: '祖師谷公園',
      },
      {
        parkId: '1090',
        parkName: '東白鬚公園',
      },
      {
        parkId: '1100',
        parkName: '浮間公園',
      },
      {
        parkId: '1110',
        parkName: '城北中央公園',
      },
      {
        parkId: '1120',
        parkName: '赤塚公園',
      },
      {
        parkId: '1130',
        parkName: '東綾瀬公園',
      },
      {
        parkId: '1140',
        parkName: '舎人公園',
      },
      {
        parkId: '1150',
        parkName: '篠崎公園Ａ',
      },
      {
        parkId: '1160',
        parkName: '大島小松川公園',
      },
      {
        parkId: '1170',
        parkName: '汐入公園',
      },
      {
        parkId: '1175',
        parkName: '高井戸公園',
      },
      {
        parkId: '1180',
        parkName: '善福寺川緑地',
      },
      {
        parkId: '1190',
        parkName: '光が丘公園',
      },
      {
        parkId: '1205',
        parkName: '石神井公園Ｂ',
      },
      {
        parkId: '1220',
        parkName: '井の頭恩賜公園',
      },
      {
        parkId: '1230',
        parkName: '武蔵野中央公園',
      },
      {
        parkId: '1240',
        parkName: '小金井公園',
      },
      {
        parkId: '1260',
        parkName: '野川公園',
      },
      {
        parkId: '1270',
        parkName: '府中の森公園',
      },
      {
        parkId: '1280',
        parkName: '東大和南公園',
      },
      {
        parkId: '1315',
        parkName: '大井ふ頭海浜公園Ｂ',
      },
      {
        parkId: '1360',
        parkName: '有明テニスＣ人工芝コート',
      },
    ],
  },
] as const

export const parks = parkGroups.flatMap((group) =>
  group.parks.map((park) => ({
    ...park,
    key: `${park.parkId}:${group.surface}` as const,
    surface: group.surface,
    label: group.label,
  })),
)
