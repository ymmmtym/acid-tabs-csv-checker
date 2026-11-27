/**
 * プライバシーバッジの文言を組み立てる。
 * 実行中は、チェックボックスではなく実行に使った条件を渡すこと。
 * 途中でチェックを外しても、走っている実行は送信を続けるため。
 */
export function privacyBadge({ rdap, deployed }) {
  if (rdap) {
    return {
      text: deployed
        ? '保存しません / 公開環境・ドメイン名を外部送信'
        : '保存しません / ドメイン名を外部送信',
      title:
        'DNS 解決に失敗したドメイン名だけを RDAP（rdap.org）へ送信します。RDAP 対応の TLD では登録機関の RDAP サーバーにも転送されます。CSV の内容は送信しません。'
    };
  }

  return {
    text: deployed ? '保存しません / 公開環境で実行中' : '保存しません / 外部送信なし',
    title: deployed
      ? 'CSV はブラウザからこのサーバーへ送信されます。ディスク・DB・ブラウザストレージには保存しません。'
      : ''
  };
}
