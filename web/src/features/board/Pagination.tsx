import { Button } from '@/components/ui/button'

type PaginationProps = {
  page: number
  pageCount: number
  onChange: (page: number) => void
  label?: string
  numbered?: boolean
  hasNext?: boolean
}

function pageItems(page: number, pageCount: number): (number | 'gap')[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index)
  const items: (number | 'gap')[] = [0]
  const start = Math.max(1, page - 1)
  const end = Math.min(pageCount - 2, page + 1)
  if (start > 1) items.push('gap')
  for (let index = start; index <= end; index += 1) items.push(index)
  if (end < pageCount - 2) items.push('gap')
  items.push(pageCount - 1)
  return items
}

export function Pagination({
  page,
  pageCount,
  onChange,
  label,
  numbered = true,
  hasNext,
}: PaginationProps) {
  if (pageCount <= 1) {
    return label ? <span className="text-[11px] text-muted-foreground">{label}</span> : null
  }
  if (!numbered) {
    return (
      <div className="flex items-center gap-2">
        {label ? <span className="text-[11px] text-muted-foreground">{label}</span> : null}
        <Button
          variant="outline"
          size="sm"
          className="px-2 text-[11px]"
          onClick={() => onChange(page - 1)}
          disabled={page === 0}
        >
          上一页
        </Button>
        <span className="text-[11px] text-muted-foreground">
          第 {page + 1} / {pageCount} 页
        </span>
        <Button
          variant="outline"
          size="sm"
          className="px-2 text-[11px]"
          onClick={() => onChange(page + 1)}
          disabled={hasNext === false || page >= pageCount - 1}
        >
          下一页
        </Button>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1">
      {label ? <span className="mr-1 text-[11px] text-muted-foreground">{label}</span> : null}
      <Button
        variant="outline"
        size="sm"
        className="px-2 text-[11px]"
        onClick={() => onChange(Math.max(0, page - 1))}
        disabled={page === 0}
      >
        上一页
      </Button>
      {pageItems(page, pageCount).map((item, index) =>
        item === 'gap' ? (
          <span key={`gap-${index}`} className="px-1 text-[11px] text-muted-foreground">
            …
          </span>
        ) : (
          <Button
            key={item}
            size="icon-sm"
            variant={item === page ? 'default' : 'ghost'}
            onClick={() => onChange(item)}
            aria-current={item === page ? 'page' : undefined}
            className="text-[11px]"
          >
            {item + 1}
          </Button>
        ),
      )}
      <Button
        variant="outline"
        size="sm"
        className="px-2 text-[11px]"
        onClick={() => onChange(Math.min(pageCount - 1, page + 1))}
        disabled={page >= pageCount - 1}
      >
        下一页
      </Button>
    </div>
  )
}
