import { Button } from '@/components/ui/button'
import {
  Pagination as PaginationNav,
  PaginationContent,
  PaginationItem,
} from '@/components/ui/pagination'

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
    return label ? <span className="text-xs text-muted-foreground">{label}</span> : null
  }
  if (!numbered) {
    return (
      <div className="flex items-center gap-2">
        {label ? <span className="text-xs text-muted-foreground">{label}</span> : null}
        <PaginationNav className="mx-0 w-fit justify-start">
          <PaginationContent className="gap-2">
            <PaginationItem>
              <Button
                variant="outline"
                size="sm"
                className="px-2 text-xs"
                onClick={() => onChange(page - 1)}
                disabled={page === 0}
              >
                上一页
              </Button>
            </PaginationItem>
            <PaginationItem className="text-xs text-muted-foreground">
              第 {page + 1} / {pageCount} 页
            </PaginationItem>
            <PaginationItem>
              <Button
                variant="outline"
                size="sm"
                className="px-2 text-xs"
                onClick={() => onChange(page + 1)}
                disabled={hasNext === false || page >= pageCount - 1}
              >
                下一页
              </Button>
            </PaginationItem>
          </PaginationContent>
        </PaginationNav>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1">
      {label ? <span className="mr-1 text-xs text-muted-foreground">{label}</span> : null}
      <PaginationNav className="mx-0 w-fit justify-start">
        <PaginationContent className="gap-1">
          <PaginationItem>
            <Button
              variant="outline"
              size="sm"
              className="px-2 text-xs"
              onClick={() => onChange(Math.max(0, page - 1))}
              disabled={page === 0}
            >
              上一页
            </Button>
          </PaginationItem>
          {pageItems(page, pageCount).map((item, index) =>
            item === 'gap' ? (
              <PaginationItem key={`gap-${index}`} className="px-1 text-xs text-muted-foreground">
                …
              </PaginationItem>
            ) : (
              <PaginationItem key={item}>
                <Button
                  size="icon-sm"
                  variant={item === page ? 'default' : 'ghost'}
                  onClick={() => onChange(item)}
                  aria-current={item === page ? 'page' : undefined}
                  className="text-xs"
                >
                  {item + 1}
                </Button>
              </PaginationItem>
            ),
          )}
          <PaginationItem>
            <Button
              variant="outline"
              size="sm"
              className="px-2 text-xs"
              onClick={() => onChange(Math.min(pageCount - 1, page + 1))}
              disabled={page >= pageCount - 1}
            >
              下一页
            </Button>
          </PaginationItem>
        </PaginationContent>
      </PaginationNav>
    </div>
  )
}
