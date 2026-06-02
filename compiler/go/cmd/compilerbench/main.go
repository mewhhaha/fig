package main

import "figcompilerbench/frontend"

func MainValue(seed int32) int32 {
	span := frontend.MakeSpan(seed, seed+12, 1, 1)
	shifted := frontend.ShiftAfter(span, seed+4, 3)
	inside := int32(0)
	if frontend.SpanContains(shifted, seed+7) {
		inside = 1
	}
	return frontend.SpanWidth(shifted) + inside + frontend.Entry(seed+3)
}

func main() {
	_ = MainValue(1)
}
