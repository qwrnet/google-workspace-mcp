/**
 * Convert Google Docs document body JSON to readable text.
 */
export function docsToText(body: any): string {
  if (!body?.content) return '';

  const lines: string[] = [];

  for (const element of body.content) {
    if (element.sectionBreak) {
      lines.push('');
      continue;
    }

    if (element.paragraph) {
      const para = element.paragraph;
      let text = '';

      if (para.elements) {
        for (const el of para.elements) {
          if (el.textRun?.content) {
            text += el.textRun.content;
          }
        }
      }

      const style = para.paragraphStyle?.namedStyleType;
      switch (style) {
        case 'HEADING_1':
          text = '# ' + text.trimEnd();
          break;
        case 'HEADING_2':
          text = '## ' + text.trimEnd();
          break;
        case 'HEADING_3':
          text = '### ' + text.trimEnd();
          break;
        case 'HEADING_4':
          text = '#### ' + text.trimEnd();
          break;
        case 'HEADING_5':
          text = '##### ' + text.trimEnd();
          break;
        case 'HEADING_6':
          text = '###### ' + text.trimEnd();
          break;
      }

      lines.push(text);
      continue;
    }

    if (element.table) {
      const table = element.table;
      let isFirstRow = true;
      for (const row of table.tableRows || []) {
        const cells: string[] = [];
        for (const cell of row.tableCells || []) {
          let cellText = '';
          for (const content of cell.content || []) {
            if (content.paragraph?.elements) {
              for (const el of content.paragraph.elements) {
                if (el.textRun?.content) {
                  cellText += el.textRun.content.replace(/\n$/, '');
                }
              }
            }
          }
          cells.push(cellText.trim());
        }
        lines.push('| ' + cells.join(' | ') + ' |');
        if (isFirstRow) {
          lines.push('| ' + cells.map(() => '---').join(' | ') + ' |');
          isFirstRow = false;
        }
      }
      lines.push('');
      continue;
    }
  }

  return lines.join('\n');
}
