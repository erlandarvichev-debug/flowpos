"""Render native Word PDF export to page PNGs and check text geometry."""
from pathlib import Path
import json
import pymupdf
ROOT=Path(__file__).resolve().parents[2]
qa=ROOT/'qa-spec';qa.mkdir(exist_ok=True)
pdf=pymupdf.open(qa/'FLOWPOS_ERP_Specification_v2_2026-10-27.pdf')
report=[]
for i,p in enumerate(pdf):
    pix=p.get_pixmap(matrix=pymupdf.Matrix(96/72,96/72),alpha=False)
    pix.save(qa/f'page-{i+1:02d}.png')
    text=p.get_text()
    out=[]
    for b in p.get_text('blocks'):
        if b[0]<0 or b[1]<0 or b[2]>p.rect.width+1 or b[3]>p.rect.height+1:out.append(b[:4])
    report.append(dict(page=i+1,characters=len(text),out_of_bounds=out))
(qa/'geometry.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'pages':len(pdf),'blank_pages':[r['page'] for r in report if r['characters']<30],'out_of_bounds':[r for r in report if r['out_of_bounds']]}))
