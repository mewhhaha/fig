package frontend

type Span struct {
	Start  int32
	End    int32
	Line   int32
	Column int32
}

func MakeSpan(start int32, end int32, line int32, column int32) Span {
	return Span{Start: start, End: end, Line: line, Column: column}
}

func SpanWidth(span Span) int32 {
	return span.End - span.Start
}

func SpanContains(span Span, offset int32) bool {
	return span.Start <= offset && offset < span.End
}

func ShiftAfter(span Span, after int32, delta int32) Span {
	if span.Start >= after {
		span.Start += delta
	}
	if span.End >= after {
		span.End += delta
	}
	return span
}

func MergeSpan(left Span, right Span) Span {
	start := right.Start
	if left.Start < right.Start {
		start = left.Start
	}
	end := right.End
	if left.End > right.End {
		end = left.End
	}
	return Span{Start: start, End: end, Line: left.Line, Column: left.Column}
}

type TokenKind int32

const (
	Import TokenKind = iota + 1
	External
	TypeKw
	ConstKw
	FnKw
	LetKw
	MatchKw
	PubKw
	BoolLiteral
	Identifier
	NumberLiteral
	StringLiteral
	CharLiteral
	MultilineLiteral
	LiteralType
	Symbol
)

type DeclarationKind int32

const (
	NoDeclaration DeclarationKind = iota
	FunctionDeclaration
	LetDeclaration
	ConstDeclaration
	TypeDeclaration
)

type ExpressionKind int32

const (
	NoExpression ExpressionKind = iota
	NumberExpression
	BooleanExpression
	NameExpression
	TextExpression
)

type Token struct {
	Kind TokenKind
	Span Span
}

type SourceText struct {
	ModuleID   int32
	BaseOffset int32
	FirstCode  int32
	SecondCode int32
	ThirdCode  int32
	FourthCode int32
	Length     int32
}

type CharClass int32

const (
	Whitespace CharClass = iota
	Lower
	Upper
	Digit
	Quote
	Slash
	SymbolChar
	End
)

type LexerCursor struct {
	Offset    int32
	Line      int32
	Column    int32
	Remaining int32
}

type LexErrorKind int32

const (
	UnknownChar LexErrorKind = iota
	UnterminatedText
)

type LexError struct {
	Kind LexErrorKind
	At   Span
}

type Lexeme struct {
	Kind TokenKind
	Span Span
}

type LexResult struct {
	Ok     bool
	Value  Lexeme
	Cursor LexerCursor
	Error  LexError
}

type TextCharClass int32

const (
	TextSpace TextCharClass = iota
	TextNewline
	TextLower
	TextUpper
	TextDigit
	TextQuote
	TextSlash
	TextPunctuation
	TextEof
)

type TextBuffer struct {
	ModuleID   int32
	BaseOffset int32
	Codes      []int32
	Length     int32
}

type TextPunct int32

const (
	PunctNone TextPunct = iota
	PunctEqual
	PunctLeftParen
	PunctRightParen
	PunctArrow
	PunctLeftBrace
	PunctRightBrace
	PunctComma
	PunctColon
	PunctSlash
	PunctOther
)

type TextToken struct {
	Token       Token
	Punctuation TextPunct
}

type TextCursor struct {
	Index  int32
	Offset int32
	Line   int32
	Column int32
}

type TextLexeme struct {
	Kind        TokenKind
	Punctuation TextPunct
	Span        Span
	ByteWidth   int32
}

type TextLexErrorKind int32

const (
	UnexpectedTextChar TextLexErrorKind = iota
	UnterminatedString
)

type TextLexError struct {
	Kind TextLexErrorKind
	Code int32
	At   Span
}

type TextLexResult struct {
	Ok     bool
	Value  TextLexeme
	Cursor TextCursor
	Error  TextLexError
}

type TextTokenStream struct {
	Items       []TextToken
	Count       int32
	Diagnostics DiagnosticBag
	SourceSpan  Span
}

type TokenStream struct {
	First      Token
	Second     Token
	Third      Token
	Fourth     Token
	Length     int32
	SourceSpan Span
}

type ModuleRecord struct {
	ModuleID int32
	ImportID int32
	Source   SourceText
}

type ModuleGraph struct {
	Root       ModuleRecord
	Dependency ModuleRecord
	Count      int32
}

type ResolveRequest struct {
	ImporterID int32
	ImportID   int32
	Span       Span
}

type ResolveResult struct {
	Ok      bool
	Module  ModuleRecord
	Request ResolveRequest
}

type ModuleCache struct {
	FirstID   int32
	SecondID  int32
	HitCount  int32
	MissCount int32
}

type ResolveState struct {
	Graph       ModuleGraph
	Cache       ModuleCache
	Diagnostics DiagnosticBag
}

type ResolveStep struct {
	State  ResolveState
	Result ResolveResult
}

type ParseState struct {
	Cursor int32
	Limit  int32
}

type ParseErrorKind int32

const (
	UnexpectedEnd ParseErrorKind = iota
	UnexpectedToken
	Ambiguous
)

type ParseError struct {
	Kind     ParseErrorKind
	Expected int32
	Actual   int32
	At       Span
}

type Severity int32

const (
	SeverityError Severity = iota
	SeverityWarning
	SeverityNote
)

type DiagnosticCode int32

const (
	CodeUnexpectedEnd DiagnosticCode = iota
	CodeUnexpectedToken
	CodeAmbiguousParse
	CodeUnknownSymbol
	CodeTypeMismatch
	CodeMissingModule
)

type Diagnostic struct {
	Code      DiagnosticCode
	Severity  Severity
	Span      Span
	Primary   int32
	Secondary int32
}

type DiagnosticBag struct {
	First      Diagnostic
	Second     Diagnostic
	Count      int32
	ErrorCount int32
}

type TypeKind int32

const (
	TypeUnknown TypeKind = iota
	TypeI32
	TypeBool
	TypeFunction
	TypeProduct
	TypeError
)

type Type struct {
	Kind       TypeKind
	ParamCount int32
	Result     int32
	FieldCount int32
}

type CheckSymbol struct {
	Name      int32
	ValueType Type
}

type CheckEnv struct {
	First       CheckSymbol
	Second      CheckSymbol
	Count       int32
	Diagnostics DiagnosticBag
}

type CheckedExpr struct {
	Expr        Expr
	ValueType   Type
	Diagnostics DiagnosticBag
}

type CheckedDecl struct {
	Decl      Decl
	ValueType Type
	Env       CheckEnv
}

type CheckedProgram struct {
	Program     Program
	Entry       CheckedDecl
	Secondary   CheckedDecl
	Env         CheckEnv
	Diagnostics DiagnosticBag
}

type AbiClass int32

const (
	AbiVoid AbiClass = iota
	AbiScalar
	AbiHandle
	AbiFunction
)

type LoweredValueKind int32

const (
	LoweredVoid LoweredValueKind = iota
	LoweredI32
	LoweredHandle
	LoweredFunction
)

type LoweredValue struct {
	Kind   LoweredValueKind
	Value  int32
	Layout int32
	Handle int32
	Index  int32
}

type LoweredDecl struct {
	Name        int32
	ABI         AbiClass
	Value       LoweredValue
	Diagnostics DiagnosticBag
}

type LoweredProgram struct {
	Program     Program
	Entry       LoweredDecl
	Secondary   LoweredDecl
	Diagnostics DiagnosticBag
}

type WasmValType int32

const (
	WasmNoVal WasmValType = iota
	WasmI32
	WasmI64
	WasmExternRef
)

type WasmInstrKind int32

const (
	InstrNop WasmInstrKind = iota
	InstrConst
	InstrLocalGet
	InstrCall
	InstrReturn
	InstrDrop
	InstrTrap
)

type WasmInstr struct {
	Kind  WasmInstrKind
	Value int32
	Index int32
	Code  int32
}

type WasmFunc struct {
	Name        int32
	ParamCount  int32
	Result      WasmValType
	First       WasmInstr
	Second      WasmInstr
	Third       WasmInstr
	Diagnostics DiagnosticBag
}

type WasmModule struct {
	First         WasmFunc
	Second        WasmFunc
	FunctionCount int32
	ExportCount   int32
	Diagnostics   DiagnosticBag
}

type WasmSectionKind int32

const (
	SectionType WasmSectionKind = iota + 1
	SectionFunction
	SectionExport
	SectionCode
)

type WasmByte struct {
	Value int32
}

type WasmBytes struct {
	First    WasmByte
	Second   WasmByte
	Third    WasmByte
	Fourth   WasmByte
	Length   int32
	Checksum int32
}

type WasmSection struct {
	Kind        WasmSectionKind
	Payload     WasmBytes
	Size        int32
	Diagnostics DiagnosticBag
}

type WasmBinary struct {
	Magic           int32
	Version         int32
	TypeSection     WasmSection
	FunctionSection WasmSection
	ExportSection   WasmSection
	CodeSection     WasmSection
	Diagnostics     DiagnosticBag
}

type CompilePhase int32

const (
	PhaseSource CompilePhase = iota
	PhaseParsed
	PhaseChecked
	PhaseLowered
)

type ModuleArtifact struct {
	ModuleID    int32
	Source      SourceText
	Decl        Decl
	Checked     CheckedDecl
	Lowered     LoweredDecl
	Diagnostics DiagnosticBag
	Phase       CompilePhase
}

type ArtifactTable struct {
	First       ModuleArtifact
	Second      ModuleArtifact
	Count       int32
	Diagnostics DiagnosticBag
}

type CompileStep struct {
	Resolve  ResolveStep
	Artifact ModuleArtifact
}

type SymbolNodeKind int32

const (
	NodeFunction SymbolNodeKind = iota
	NodeValue
	NodeType
	NodeImport
)

type DeclEdgeKind int32

const (
	ValueDependency DeclEdgeKind = iota
	TypeDependency
	ImportDependency
)

type ResolutionStateKind int32

const (
	Pending ResolutionStateKind = iota
	Resolved
	Failed
)

type ResolutionState struct {
	Kind        ResolutionStateKind
	Diagnostics DiagnosticBag
}

type DeclNode struct {
	NodeID       int32
	Name         int32
	Decl         Decl
	Kind         SymbolNodeKind
	DeclaredType Type
	InferredType Type
	State        ResolutionState
	Span         Span
}

type DeclEdge struct {
	FromID int32
	ToID   int32
	Kind   DeclEdgeKind
	Weight int32
}

type SymbolGraph struct {
	First       DeclNode
	Second      DeclNode
	Third       DeclNode
	Fourth      DeclNode
	FirstEdge   DeclEdge
	SecondEdge  DeclEdge
	ThirdEdge   DeclEdge
	NodeCount   int32
	EdgeCount   int32
	Diagnostics DiagnosticBag
}

type ResolutionOrder struct {
	FirstID    int32
	SecondID   int32
	ThirdID    int32
	FourthID   int32
	Count      int32
	CycleCount int32
}

type ModuleRole int32

const (
	RootModule ModuleRole = iota
	FeatureModule
	UtilityModule
	SharedModule
)

type SourceChangeKind int32

const (
	NoChange SourceChangeKind = iota
	EditModule
)

type SourceChange struct {
	Kind  SourceChangeKind
	Role  ModuleRole
	Delta int32
}

type InvalidationReasonKind int32

const (
	NoInvalidation InvalidationReasonKind = iota
	SourceChanged
	DependencyChanged
)

type InvalidationReason struct {
	Kind     InvalidationReasonKind
	ModuleID int32
}

type CacheEntryStateKind int32

const (
	CacheMissing CacheEntryStateKind = iota
	CacheFresh
	CacheStale
)

type CacheEntryState struct {
	Kind   CacheEntryStateKind
	Reason InvalidationReason
}

type ModuleNode struct {
	Role               ModuleRole
	Record             ModuleRecord
	SecondImportID     int32
	SourceRevision     int32
	DependencyRevision int32
}

type ModuleCluster struct {
	Root    ModuleNode
	Feature ModuleNode
	Utility ModuleNode
	Shared  ModuleNode
	Count   int32
}

type CacheEntry struct {
	ModuleID           int32
	SourceRevision     int32
	DependencyRevision int32
	ArtifactRevision   int32
	Compiled           ModuleArtifact
	State              CacheEntryState
}

type ArtifactCache struct {
	Root              CacheEntry
	Feature           CacheEntry
	Utility           CacheEntry
	Shared            CacheEntry
	HitCount          int32
	MissCount         int32
	InvalidationCount int32
}

type RefreshStep struct {
	Before CacheEntry
	After  CacheEntry
	Reason InvalidationReason
}

type RefreshPlan struct {
	Root        RefreshStep
	Feature     RefreshStep
	Utility     RefreshStep
	Shared      RefreshStep
	Cache       ArtifactCache
	Diagnostics DiagnosticBag
}

type DeclFrame struct {
	Decl     Decl
	Consumed int32
}

type ExprFrame struct {
	Expr     Expr
	Consumed int32
}

type ParamFrame struct {
	Name       int32
	Annotation TypeAnnotation
	Consumed   int32
}

type ParamListFrame struct {
	Count    int32
	Consumed int32
}

type TypeAnnotationFrame struct {
	Annotation TypeAnnotation
	Consumed   int32
}

type ProgramFrame struct {
	Program     Program
	Diagnostics DiagnosticBag
	Consumed    int32
}

type ParseResult struct {
	Ok    bool
	State ParseState
	Value DeclFrame
	Error ParseError
}

type ExprParseResult struct {
	Ok    bool
	State ParseState
	Value ExprFrame
	Error ParseError
}

type ParamParseResult struct {
	Ok    bool
	State ParseState
	Value ParamFrame
	Error ParseError
}

type ParamListParseResult struct {
	Ok    bool
	State ParseState
	Value ParamListFrame
	Error ParseError
}

type TypeAnnotationParseResult struct {
	Ok    bool
	State ParseState
	Value TypeAnnotationFrame
	Error ParseError
}

type ProgramParseResult struct {
	Ok    bool
	State ParseState
	Value ProgramFrame
	Error ParseError
}

func State(cursor int32, limit int32) ParseState {
	return ParseState{Cursor: cursor, Limit: limit}
}

func ParseErrorSpan(error ParseError) Span {
	return error.At
}

func ParseErrorTag(error ParseError) int32 {
	switch error.Kind {
	case UnexpectedEnd:
		return 1
	case UnexpectedToken:
		return 2
	default:
		return 3
	}
}

func ParseErrorExpected(error ParseError) int32 {
	return error.Expected
}

func ParseErrorActual(error ParseError) int32 {
	return error.Actual
}

func Cursor(offset int32, line int32, column int32, remaining int32) LexerCursor {
	return LexerCursor{Offset: offset, Line: line, Column: column, Remaining: remaining}
}

func MakeSourceText(
	moduleID int32,
	baseOffset int32,
	firstCode int32,
	secondCode int32,
	thirdCode int32,
	fourthCode int32,
) SourceText {
	return SourceText{
		ModuleID:   moduleID,
		BaseOffset: baseOffset,
		FirstCode:  firstCode,
		SecondCode: secondCode,
		ThirdCode:  thirdCode,
		FourthCode: fourthCode,
		Length:     4,
	}
}

func SourceFromSeed(seed int32) SourceText {
	return MakeSourceText(
		seed,
		seed*4,
		(seed%11)+1,
		((seed+3)%13)+1,
		((seed+5)%17)+1,
		((seed+7)%19)+1,
	)
}

func SourceCodeAt(source SourceText, index int32) int32 {
	switch index {
	case 0:
		return source.FirstCode
	case 1:
		return source.SecondCode
	case 2:
		return source.ThirdCode
	case 3:
		return source.FourthCode
	default:
		return 0
	}
}

func SourceOffsetAt(source SourceText, index int32) int32 {
	return source.BaseOffset + index
}

func SourceSpanAt(source SourceText, index int32, width int32) Span {
	return MakeSpan(SourceOffsetAt(source, index), SourceOffsetAt(source, index)+width, 1, index+1)
}

func SourceModuleSeed(source SourceText) int32 {
	return source.ModuleID + source.BaseOffset
}

func SourceScore(source SourceText) int32 {
	return source.ModuleID +
		source.BaseOffset +
		source.FirstCode +
		source.SecondCode +
		source.ThirdCode +
		source.FourthCode +
		source.Length
}

func MakeModuleRecord(moduleID int32, importID int32, source SourceText) ModuleRecord {
	return ModuleRecord{ModuleID: moduleID, ImportID: importID, Source: source}
}

func ModuleGraphFromSeed(seed int32) ModuleGraph {
	dependency := MakeModuleRecord(seed+1, 0, SourceFromSeed(seed+1))
	root := MakeModuleRecord(seed, dependency.ModuleID, SourceFromSeed(seed))
	return ModuleGraph{Root: root, Dependency: dependency, Count: 2}
}

func RootSource(graph ModuleGraph) SourceText {
	return graph.Root.Source
}

func RootID(graph ModuleGraph) int32 {
	return graph.Root.ModuleID
}

func RootImportID(graph ModuleGraph) int32 {
	return graph.Root.ImportID
}

func DependencySource(graph ModuleGraph) SourceText {
	return graph.Dependency.Source
}

func ResolveImport(graph ModuleGraph, importID int32) SourceText {
	if graph.Dependency.ModuleID == importID {
		return graph.Dependency.Source
	}
	return graph.Root.Source
}

func ModuleScore(module ModuleRecord) int32 {
	return module.ModuleID + module.ImportID + SourceScore(module.Source)
}

func GraphScore(graph ModuleGraph) int32 {
	return ModuleScore(graph.Root) + ModuleScore(graph.Dependency) + graph.Count
}

func MakeResolveRequest(importerID int32, importID int32, sourceSpan Span) ResolveRequest {
	return ResolveRequest{ImporterID: importerID, ImportID: importID, Span: sourceSpan}
}

func EmptyModuleCache() ModuleCache {
	return ModuleCache{FirstID: -1, SecondID: -1}
}

func SeedModuleCache(graph ModuleGraph) ModuleCache {
	return ModuleCache{FirstID: RootID(graph), SecondID: -1}
}

func NewResolveState(graph ModuleGraph) ResolveState {
	return ResolveState{
		Graph:       graph,
		Cache:       SeedModuleCache(graph),
		Diagnostics: EmptyDiagnosticBag(),
	}
}

func CacheContains(cache ModuleCache, moduleID int32) bool {
	if cache.FirstID == moduleID {
		return true
	}
	return cache.SecondID == moduleID
}

func RecordCacheProbe(cache ModuleCache, moduleID int32) ModuleCache {
	if CacheContains(cache, moduleID) {
		return ModuleCache{
			FirstID:   cache.FirstID,
			SecondID:  cache.SecondID,
			HitCount:  cache.HitCount + 1,
			MissCount: cache.MissCount,
		}
	}
	return ModuleCache{
		FirstID:   cache.FirstID,
		SecondID:  moduleID,
		HitCount:  cache.HitCount,
		MissCount: cache.MissCount + 1,
	}
}

func ResolveGraph(graph ModuleGraph, request ResolveRequest) ResolveResult {
	if graph.Dependency.ModuleID == request.ImportID {
		return ResolveResult{Ok: true, Module: graph.Dependency, Request: request}
	}
	if graph.Root.ModuleID == request.ImportID {
		return ResolveResult{Ok: true, Module: graph.Root, Request: request}
	}
	return ResolveResult{Ok: false, Request: request}
}

func MissingModuleDiagnostic(request ResolveRequest) Diagnostic {
	return MakeDiagnostic(
		CodeMissingModule,
		SeverityError,
		request.Span,
		request.ImportID,
		request.ImporterID,
	)
}

func DiagnosticsAfterResult(diagnostics DiagnosticBag, result ResolveResult) DiagnosticBag {
	if result.Ok {
		return diagnostics
	}
	return PushDiagnostic(diagnostics, MissingModuleDiagnostic(result.Request))
}

func ResultModuleID(result ResolveResult) int32 {
	if result.Ok {
		return result.Module.ModuleID
	}
	return result.Request.ImportID
}

func ResolveModule(current ResolveState, request ResolveRequest) ResolveStep {
	result := ResolveGraph(current.Graph, request)
	return ResolveStep{
		State: ResolveState{
			Graph:       current.Graph,
			Cache:       RecordCacheProbe(current.Cache, ResultModuleID(result)),
			Diagnostics: DiagnosticsAfterResult(current.Diagnostics, result),
		},
		Result: result,
	}
}

func ResultSource(result ResolveResult, graph ModuleGraph) SourceText {
	if result.Ok {
		return result.Module.Source
	}
	return RootSource(graph)
}

func StepSource(step ResolveStep) SourceText {
	return ResultSource(step.Result, step.State.Graph)
}

func CacheScore(cache ModuleCache) int32 {
	return cache.FirstID + cache.SecondID + cache.HitCount + cache.MissCount
}

func ResolveResultScore(result ResolveResult) int32 {
	if result.Ok {
		return ModuleScore(result.Module)
	}
	return 0 - result.Request.ImportID
}

func ResolveStateScore(state ResolveState) int32 {
	return GraphScore(state.Graph) +
		CacheScore(state.Cache) +
		DiagnosticBagScore(state.Diagnostics)
}

func ResolveStepScore(step ResolveStep) int32 {
	return ResolveStateScore(step.State) + ResolveResultScore(step.Result)
}

func NormalizeGeneratedKind(code int32) TokenKind {
	switch code {
	case 1:
		return Import
	case 2:
		return External
	case 3:
		return TypeKw
	case 4:
		return ConstKw
	case 5:
		return FnKw
	case 6:
		return LetKw
	case 7:
		return MatchKw
	case 8:
		return PubKw
	case 9:
		return BoolLiteral
	case 10:
		return Identifier
	case 11:
		return NumberLiteral
	case 12:
		return StringLiteral
	case 13:
		return CharLiteral
	case 14:
		return MultilineLiteral
	case 15:
		return LiteralType
	default:
		return Symbol
	}
}

func AtSpan(current LexerCursor, width int32) Span {
	return MakeSpan(current.Offset, current.Offset+width, current.Line, current.Column)
}

func BoundedRemaining(current LexerCursor, width int32) int32 {
	if current.Remaining > width {
		return current.Remaining - width
	}
	return 0
}

func AdvanceCursor(current LexerCursor, width int32) LexerCursor {
	return LexerCursor{
		Offset:    current.Offset + width,
		Line:      current.Line,
		Column:    current.Column + width,
		Remaining: BoundedRemaining(current, width),
	}
}

func ClassifyCode(code int32) CharClass {
	switch code {
	case 0:
		return End
	case 1:
		return Whitespace
	case 2:
		return Lower
	case 3:
		return Upper
	case 4:
		return Digit
	case 5:
		return Quote
	case 6:
		return Slash
	default:
		switch code % 5 {
		case 0:
			return SymbolChar
		case 1:
			return Lower
		case 2:
			return Upper
		case 3:
			return Digit
		default:
			return Whitespace
		}
	}
}

func KindFromClass(class CharClass) TokenKind {
	switch class {
	case Lower:
		return Identifier
	case Upper:
		return LiteralType
	case Digit:
		return NumberLiteral
	case Quote:
		return StringLiteral
	default:
		return Symbol
	}
}

func LexWidth(class CharClass, seed int32) int32 {
	switch class {
	case Whitespace:
		return 1
	case Lower:
		return (seed % 8) + 1
	case Upper:
		return (seed % 6) + 1
	case Digit:
		return (seed % 5) + 1
	case Quote:
		return (seed % 10) + 2
	case Slash:
		return 1
	case SymbolChar:
		return 1
	default:
		return 0
	}
}

func IsEnd(class CharClass) bool {
	return class == End
}

func IsUnterminated(class CharClass, seed int32) bool {
	if class == Quote {
		return seed%11 == 0
	}
	return false
}

func LexOne(current LexerCursor, class CharClass, seed int32) LexResult {
	width := LexWidth(class, seed)
	sourceSpan := AtSpan(current, width)
	if IsEnd(class) {
		return LexResult{
			Ok:    false,
			Error: LexError{Kind: UnknownChar, At: sourceSpan},
		}
	}
	if IsUnterminated(class, seed) {
		return LexResult{
			Ok:    false,
			Error: LexError{Kind: UnterminatedText, At: sourceSpan},
		}
	}
	return LexResult{
		Ok:     true,
		Value:  Lexeme{Kind: KindFromClass(class), Span: sourceSpan},
		Cursor: AdvanceCursor(current, width),
	}
}

func ErrorSpan(error LexError) Span {
	return error.At
}

func TokenFromLexeme(value Lexeme) Token {
	return Token{Kind: value.Kind, Span: value.Span}
}

func TokenOrSymbol(result LexResult) Token {
	if result.Ok {
		return TokenFromLexeme(result.Value)
	}
	return Token{Kind: Symbol, Span: ErrorSpan(result.Error)}
}

func FirstTokenFromSeed(seed int32) Token {
	current := Cursor(seed, 1, 1, (seed%64)+32)
	class := ClassifyCode((seed % 13) + 1)
	return TokenOrSymbol(LexOne(current, class, seed))
}

func CursorFromSource(source SourceText, index int32) LexerCursor {
	return Cursor(SourceOffsetAt(source, index), 1, index+1, source.Length-index)
}

func LexSourceAt(source SourceText, index int32) LexResult {
	return LexOne(
		CursorFromSource(source, index),
		ClassifyCode(SourceCodeAt(source, index)),
		SourceModuleSeed(source)+index,
	)
}

func FirstTokenFromSource(source SourceText) Token {
	return TokenOrSymbol(LexSourceAt(source, 0))
}

func LexResultScore(result LexResult) int32 {
	if result.Ok {
		return TokenScore(TokenFromLexeme(result.Value)) + result.Cursor.Offset + result.Cursor.Remaining
	}
	return 0 - SpanWidth(ErrorSpan(result.Error))
}

func MakeTextBuffer(moduleID int32, baseOffset int32, codes []int32) TextBuffer {
	return TextBuffer{
		ModuleID:   moduleID,
		BaseOffset: baseOffset,
		Codes:      codes,
		Length:     int32(len(codes)),
	}
}

func TextBufferFromSeed(seed int32) TextBuffer {
	return MakeTextBuffer(
		seed,
		seed*16,
		[]int32{
			108,
			101,
			116,
			32,
			120 + (seed % 3),
			58,
			66 + (seed % 3),
			40,
			73,
			41,
			61,
			49 + (seed % 3),
			32,
			99,
			111,
			110,
			115,
			116,
			32,
			121,
			58,
			73,
			61,
			50 + (seed % 3),
		},
	)
}

func FunctionTextBufferFromSeed(seed int32) TextBuffer {
	name := int32(102) + (seed % 3)
	paramName := int32(120) + (seed % 3)
	return MakeTextBuffer(
		seed,
		seed*16,
		[]int32{
			102,
			110,
			32,
			name,
			40,
			paramName,
			58,
			73,
			41,
			45,
			62,
			73,
			123,
			name,
			40,
			paramName,
			41,
			125,
		},
	)
}

func ZeroFunctionTextBufferFromSeed(seed int32) TextBuffer {
	name := int32(102) + (seed % 3)
	return MakeTextBuffer(
		seed,
		seed*16,
		[]int32{
			102,
			110,
			32,
			name,
			40,
			41,
			45,
			62,
			73,
			123,
			49 + (seed % 3),
			125,
		},
	)
}

func PubFunctionTextBufferFromSeed(seed int32) TextBuffer {
	name := int32(102) + (seed % 3)
	return MakeTextBuffer(
		seed,
		seed*16,
		[]int32{
			112,
			117,
			98,
			32,
			102,
			110,
			32,
			name,
			40,
			41,
			45,
			62,
			73,
			123,
			49 + (seed % 3),
			125,
		},
	)
}

func MultiFunctionTextBufferFromSeed(seed int32) TextBuffer {
	name := int32(102) + (seed % 3)
	firstParam := int32(120) + (seed % 3)
	secondParam := int32(97) + (seed % 3)
	return MakeTextBuffer(
		seed,
		seed*16,
		[]int32{
			102,
			110,
			32,
			name,
			40,
			firstParam,
			58,
			73,
			44,
			secondParam,
			58,
			73,
			41,
			45,
			62,
			73,
			123,
			name,
			40,
			firstParam,
			41,
			125,
		},
	)
}

func ThreeFunctionTextBufferFromSeed(seed int32) TextBuffer {
	name := int32(102) + (seed % 3)
	firstParam := int32(120) + (seed % 3)
	secondParam := int32(97) + (seed % 3)
	thirdParam := int32(109) + (seed % 3)
	return MakeTextBuffer(
		seed,
		seed*16,
		[]int32{
			102,
			110,
			32,
			name,
			40,
			firstParam,
			58,
			73,
			44,
			secondParam,
			58,
			73,
			44,
			thirdParam,
			58,
			73,
			41,
			45,
			62,
			73,
			123,
			name,
			40,
			firstParam,
			41,
			125,
		},
	)
}

func TextCodeAt(text TextBuffer, index int32) int32 {
	if index >= 0 && index < text.Length {
		return text.Codes[index]
	}
	return 0
}

func TextCursorAt(text TextBuffer, index int32) TextCursor {
	return TextCursor{
		Index:  index,
		Offset: text.BaseOffset + index,
		Line:   1,
		Column: index + 1,
	}
}

func TextCursorSpan(cursor TextCursor, width int32) Span {
	return MakeSpan(cursor.Offset, cursor.Offset+width, cursor.Line, cursor.Column)
}

func AdvanceTextCursor(cursor TextCursor, width int32) TextCursor {
	return TextCursor{
		Index:  cursor.Index + width,
		Offset: cursor.Offset + width,
		Line:   cursor.Line,
		Column: cursor.Column + width,
	}
}

func IsLowerCode(code int32) bool {
	if code >= 97 {
		return code <= 122
	}
	return false
}

func IsUpperCode(code int32) bool {
	if code >= 65 {
		return code <= 90
	}
	return false
}

func IsDigitCode(code int32) bool {
	if code >= 48 {
		return code <= 57
	}
	return false
}

func ClassifyTextCode(code int32) TextCharClass {
	switch code {
	case 0:
		return TextEof
	case 10:
		return TextNewline
	case 32:
		return TextSpace
	case 34:
		return TextQuote
	case 47:
		return TextSlash
	default:
		if IsLowerCode(code) {
			return TextLower
		}
		if IsUpperCode(code) {
			return TextUpper
		}
		if IsDigitCode(code) {
			return TextDigit
		}
		return TextPunctuation
	}
}

func CanContinueName(class TextCharClass) bool {
	switch class {
	case TextLower:
		return true
	case TextUpper:
		return true
	case TextDigit:
		return true
	default:
		return false
	}
}

func CanContinueNumber(class TextCharClass) bool {
	return class == TextDigit
}

func TokenKindFromTextClass(class TextCharClass) TokenKind {
	switch class {
	case TextLower:
		return Identifier
	case TextUpper:
		return LiteralType
	case TextDigit:
		return NumberLiteral
	case TextQuote:
		return StringLiteral
	default:
		return Symbol
	}
}

func TextNameMatches(
	text TextBuffer,
	start int32,
	actualWidth int32,
	expectedWidth int32,
	first int32,
	second int32,
	third int32,
	fourth int32,
	fifth int32,
	sixth int32,
	seventh int32,
	eighth int32,
) bool {
	if actualWidth != expectedWidth {
		return false
	}
	if expectedWidth > 0 && TextCodeAt(text, start) != first {
		return false
	}
	if expectedWidth > 1 && TextCodeAt(text, start+1) != second {
		return false
	}
	if expectedWidth > 2 && TextCodeAt(text, start+2) != third {
		return false
	}
	if expectedWidth > 3 && TextCodeAt(text, start+3) != fourth {
		return false
	}
	if expectedWidth > 4 && TextCodeAt(text, start+4) != fifth {
		return false
	}
	if expectedWidth > 5 && TextCodeAt(text, start+5) != sixth {
		return false
	}
	if expectedWidth > 6 && TextCodeAt(text, start+6) != seventh {
		return false
	}
	if expectedWidth > 7 && TextCodeAt(text, start+7) != eighth {
		return false
	}
	return true
}

func LowerNameKind(text TextBuffer, start int32, width int32) TokenKind {
	if TextNameMatches(text, start, width, 2, 102, 110, 0, 0, 0, 0, 0, 0) {
		return FnKw
	}
	if TextNameMatches(text, start, width, 3, 108, 101, 116, 0, 0, 0, 0, 0) {
		return LetKw
	}
	if TextNameMatches(text, start, width, 3, 112, 117, 98, 0, 0, 0, 0, 0) {
		return PubKw
	}
	if TextNameMatches(text, start, width, 4, 116, 121, 112, 101, 0, 0, 0, 0) {
		return TypeKw
	}
	if TextNameMatches(text, start, width, 4, 116, 114, 117, 101, 0, 0, 0, 0) {
		return BoolLiteral
	}
	if TextNameMatches(text, start, width, 5, 99, 111, 110, 115, 116, 0, 0, 0) {
		return ConstKw
	}
	if TextNameMatches(text, start, width, 5, 102, 97, 108, 115, 101, 0, 0, 0) {
		return BoolLiteral
	}
	if TextNameMatches(text, start, width, 5, 109, 97, 116, 99, 104, 0, 0, 0) {
		return MatchKw
	}
	if TextNameMatches(text, start, width, 6, 105, 109, 112, 111, 114, 116, 0, 0) {
		return Import
	}
	if TextNameMatches(text, start, width, 8, 101, 120, 116, 101, 114, 110, 97, 108) {
		return External
	}
	return Identifier
}

func ScanNameWidth(text TextBuffer, start int32) int32 {
	one := ClassifyTextCode(TextCodeAt(text, start+1))
	two := ClassifyTextCode(TextCodeAt(text, start+2))
	three := ClassifyTextCode(TextCodeAt(text, start+3))
	four := ClassifyTextCode(TextCodeAt(text, start+4))
	five := ClassifyTextCode(TextCodeAt(text, start+5))
	six := ClassifyTextCode(TextCodeAt(text, start+6))
	seven := ClassifyTextCode(TextCodeAt(text, start+7))
	if !CanContinueName(one) {
		return 1
	}
	if !CanContinueName(two) {
		return 2
	}
	if !CanContinueName(three) {
		return 3
	}
	if !CanContinueName(four) {
		return 4
	}
	if !CanContinueName(five) {
		return 5
	}
	if !CanContinueName(six) {
		return 6
	}
	if !CanContinueName(seven) {
		return 7
	}
	return 8
}

func ScanNumberWidth(text TextBuffer, start int32) int32 {
	one := ClassifyTextCode(TextCodeAt(text, start+1))
	two := ClassifyTextCode(TextCodeAt(text, start+2))
	if !CanContinueNumber(one) {
		return 1
	}
	if !CanContinueNumber(two) {
		return 2
	}
	return 3
}

func TextStringWidth(text TextBuffer, start int32) int32 {
	one := TextCodeAt(text, start+1)
	two := TextCodeAt(text, start+2)
	three := TextCodeAt(text, start+3)
	if one == 34 {
		return 2
	}
	if two == 34 {
		return 3
	}
	if three == 34 {
		return 4
	}
	return 0
}

func TextPunctuationWidth(text TextBuffer, start int32) int32 {
	if TextCodeAt(text, start) == 45 {
		if TextCodeAt(text, start+1) == 62 {
			return 2
		}
	}
	return 1
}

func TextPunctuationKind(text TextBuffer, start int32, width int32) TextPunct {
	switch TextCodeAt(text, start) {
	case 40:
		return PunctLeftParen
	case 41:
		return PunctRightParen
	case 44:
		return PunctComma
	case 45:
		if width == 2 {
			return PunctArrow
		}
		return PunctOther
	case 47:
		return PunctSlash
	case 58:
		return PunctColon
	case 61:
		return PunctEqual
	case 123:
		return PunctLeftBrace
	case 125:
		return PunctRightBrace
	default:
		return PunctOther
	}
}

func MakeTextLexeme(
	kind TokenKind,
	punctuation TextPunct,
	cursor TextCursor,
	width int32,
) TextLexeme {
	return TextLexeme{
		Kind:        kind,
		Punctuation: punctuation,
		Span:        TextCursorSpan(cursor, width),
		ByteWidth:   width,
	}
}

func TextLexOne(text TextBuffer, cursor TextCursor) TextLexResult {
	code := TextCodeAt(text, cursor.Index)
	class := ClassifyTextCode(code)
	switch class {
	case TextEof:
		return TextLexResult{Error: TextLexError{
			Kind: UnexpectedTextChar,
			Code: code,
			At:   TextCursorSpan(cursor, 0),
		}}
	case TextNewline:
		return TextLexResult{
			Ok:    true,
			Value: MakeTextLexeme(TokenKindFromTextClass(class), PunctNone, cursor, 1),
			Cursor: TextCursor{
				Index:  cursor.Index + 1,
				Offset: cursor.Offset + 1,
				Line:   cursor.Line + 1,
				Column: 1,
			},
		}
	case TextLower:
		width := ScanNameWidth(text, cursor.Index)
		return TextLexResult{
			Ok:     true,
			Value:  MakeTextLexeme(LowerNameKind(text, cursor.Index, width), PunctNone, cursor, width),
			Cursor: AdvanceTextCursor(cursor, width),
		}
	case TextUpper:
		width := ScanNameWidth(text, cursor.Index)
		return TextLexResult{
			Ok:     true,
			Value:  MakeTextLexeme(TokenKindFromTextClass(class), PunctNone, cursor, width),
			Cursor: AdvanceTextCursor(cursor, width),
		}
	case TextDigit:
		width := ScanNumberWidth(text, cursor.Index)
		return TextLexResult{
			Ok:     true,
			Value:  MakeTextLexeme(TokenKindFromTextClass(class), PunctNone, cursor, width),
			Cursor: AdvanceTextCursor(cursor, width),
		}
	case TextQuote:
		width := TextStringWidth(text, cursor.Index)
		if width == 0 {
			return TextLexResult{Error: TextLexError{
				Kind: UnterminatedString,
				At:   TextCursorSpan(cursor, text.Length-cursor.Index),
			}}
		}
		return TextLexResult{
			Ok:     true,
			Value:  MakeTextLexeme(TokenKindFromTextClass(class), PunctNone, cursor, width),
			Cursor: AdvanceTextCursor(cursor, width),
		}
	case TextSlash:
		return TextLexResult{
			Ok:     true,
			Value:  MakeTextLexeme(TokenKindFromTextClass(class), PunctSlash, cursor, 1),
			Cursor: AdvanceTextCursor(cursor, 1),
		}
	case TextPunctuation:
		width := TextPunctuationWidth(text, cursor.Index)
		return TextLexResult{
			Ok: true,
			Value: MakeTextLexeme(
				TokenKindFromTextClass(class),
				TextPunctuationKind(text, cursor.Index, width),
				cursor,
				width,
			),
			Cursor: AdvanceTextCursor(cursor, width),
		}
	default:
		return TextLexResult{
			Ok:     true,
			Value:  MakeTextLexeme(TokenKindFromTextClass(class), PunctNone, cursor, 1),
			Cursor: AdvanceTextCursor(cursor, 1),
		}
	}
}

func AdvanceTextTrivia(class TextCharClass, cursor TextCursor) TextCursor {
	switch class {
	case TextSpace:
		return AdvanceTextCursor(cursor, 1)
	case TextNewline:
		return TextCursor{
			Index:  cursor.Index + 1,
			Offset: cursor.Offset + 1,
			Line:   cursor.Line + 1,
			Column: 1,
		}
	default:
		return cursor
	}
}

func TextLexToken(text TextBuffer, cursor TextCursor) TextLexResult {
	class := ClassifyTextCode(TextCodeAt(text, cursor.Index))
	return TextLexOne(text, AdvanceTextTrivia(class, cursor))
}

func TextErrorSpan(error TextLexError) Span {
	return error.At
}

func TokenFromTextResult(result TextLexResult) Token {
	if result.Ok {
		return Token{Kind: result.Value.Kind, Span: result.Value.Span}
	}
	return Token{Kind: Symbol, Span: TextErrorSpan(result.Error)}
}

func TextTokenFromTextResult(result TextLexResult) TextToken {
	if result.Ok {
		return TextToken{
			Token:       Token{Kind: result.Value.Kind, Span: result.Value.Span},
			Punctuation: result.Value.Punctuation,
		}
	}
	return TextToken{
		Token:       Token{Kind: Symbol, Span: TextErrorSpan(result.Error)},
		Punctuation: PunctOther,
	}
}

func CursorFromTextResult(result TextLexResult, fallback TextCursor) TextCursor {
	if result.Ok {
		return result.Cursor
	}
	return fallback
}

func SafeCursorFromTextResult(result TextLexResult, current TextCursor, fallback TextCursor) TextCursor {
	candidate := CursorFromTextResult(result, fallback)
	if candidate.Index > current.Index {
		return candidate
	}
	return fallback
}

func DiagnosticFromTextError(error TextLexError) Diagnostic {
	if error.Kind == UnexpectedTextChar {
		return MakeDiagnostic(CodeUnexpectedToken, SeverityError, error.At, error.Code, 0)
	}
	return MakeDiagnostic(CodeUnexpectedEnd, SeverityError, error.At, 53, 0)
}

func PushTextError(bag DiagnosticBag, result TextLexResult) DiagnosticBag {
	if result.Ok {
		return bag
	}
	return PushDiagnostic(bag, DiagnosticFromTextError(result.Error))
}

func TextResultCount(result TextLexResult) int32 {
	if result.Ok && result.Value.ByteWidth > 0 {
		return 1
	}
	if !result.Ok {
		return 1
	}
	return 0
}

func TextStreamFromBuffer(text TextBuffer) TextTokenStream {
	start := TextCursorAt(text, 0)
	cursor := start
	items := make([]TextToken, 0, text.Length)
	count := int32(0)
	diagnostics := EmptyDiagnosticBag()
	sourceSpan := TextCursorSpan(start, 0)
	for cursor.Index < text.Length {
		result := TextLexToken(text, cursor)
		item := TextTokenFromTextResult(result)
		items = append(items, item)
		if count == 0 {
			sourceSpan = item.Token.Span
		} else {
			sourceSpan = MergeSpan(sourceSpan, item.Token.Span)
		}
		count += TextResultCount(result)
		diagnostics = PushTextError(diagnostics, result)
		fallbackCursor := AdvanceTextCursor(cursor, 1)
		cursor = SafeCursorFromTextResult(result, cursor, fallbackCursor)
	}
	return TextTokenStream{
		Items:       items,
		Count:       count,
		Diagnostics: diagnostics,
		SourceSpan:  sourceSpan,
	}
}

func TextTokenStreamLength(source TextTokenStream) int32 {
	return source.Count
}

func TextTokenStreamSpan(source TextTokenStream) Span {
	return source.SourceSpan
}

func TextTokenObjectAt(source TextTokenStream, index int32) TextToken {
	if index >= 0 && index < source.Count {
		return source.Items[index]
	}
	return TextToken{
		Token:       Token{Kind: Symbol, Span: TextTokenStreamSpan(source)},
		Punctuation: PunctOther,
	}
}

func TextTokenAt(source TextTokenStream, index int32) Token {
	return TextTokenObjectAt(source, index).Token
}

func TextPunctuationAt(source TextTokenStream, index int32) TextPunct {
	return TextTokenObjectAt(source, index).Punctuation
}

func TextPunctuationScore(value TextPunct) int32 {
	switch value {
	case PunctNone:
		return 0
	case PunctEqual:
		return 1
	case PunctLeftParen:
		return 2
	case PunctRightParen:
		return 3
	case PunctArrow:
		return 4
	case PunctLeftBrace:
		return 5
	case PunctRightBrace:
		return 6
	case PunctComma:
		return 7
	case PunctColon:
		return 8
	case PunctSlash:
		return 9
	default:
		return 10
	}
}

func TextLexemeScore(value TextLexeme) int32 {
	return TokenScore(Token{Kind: value.Kind, Span: value.Span}) +
		TextPunctuationScore(value.Punctuation) +
		value.ByteWidth
}

func TextLexResultScore(result TextLexResult) int32 {
	if result.Ok {
		return TextLexemeScore(result.Value) + result.Cursor.Index + result.Cursor.Column
	}
	return 0 - SpanWidth(TextErrorSpan(result.Error))
}

func TextTokenStreamScore(stream TextTokenStream) int32 {
	total := int32(0)
	for _, item := range stream.Items {
		total += TextTokenScore(item)
	}
	return total +
		stream.Count +
		DiagnosticBagScore(stream.Diagnostics)
}

func TextTokenScore(value TextToken) int32 {
	return TokenScore(value.Token) + TextPunctuationScore(value.Punctuation)
}

func TextBufferScore(text TextBuffer) int32 {
	total := int32(0)
	for _, code := range text.Codes {
		total += code
	}
	return text.ModuleID +
		text.BaseOffset +
		text.Length +
		total
}

func TextLexEntry(seed int32) int32 {
	text := TextBufferFromSeed(seed)
	functionText := FunctionTextBufferFromSeed(seed + 1)
	multiFunctionText := MultiFunctionTextBufferFromSeed(seed + 2)
	zeroFunctionText := ZeroFunctionTextBufferFromSeed(seed + 3)
	threeFunctionText := ThreeFunctionTextBufferFromSeed(seed + 4)
	pubFunctionText := PubFunctionTextBufferFromSeed(seed + 5)
	return TextBufferScore(text) +
		TextLexResultScore(TextLexOne(text, TextCursorAt(text, seed%4))) +
		TextTokenStreamScore(TextStreamFromBuffer(text)) +
		TextBufferScore(functionText) +
		TextTokenStreamScore(TextStreamFromBuffer(functionText)) +
		TextBufferScore(multiFunctionText) +
		TextTokenStreamScore(TextStreamFromBuffer(multiFunctionText)) +
		TextBufferScore(zeroFunctionText) +
		TextTokenStreamScore(TextStreamFromBuffer(zeroFunctionText)) +
		TextBufferScore(threeFunctionText) +
		TextTokenStreamScore(TextStreamFromBuffer(threeFunctionText)) +
		TextBufferScore(pubFunctionText) +
		TextTokenStreamScore(TextStreamFromBuffer(pubFunctionText))
}

func MakeTokenStream(first Token, second Token, third Token, fourth Token) TokenStream {
	firstPair := MergeSpan(first.Span, second.Span)
	secondPair := MergeSpan(third.Span, fourth.Span)
	return TokenStream{
		First:      first,
		Second:     second,
		Third:      third,
		Fourth:     fourth,
		Length:     4,
		SourceSpan: MergeSpan(firstPair, secondPair),
	}
}

func TokenAt(source TokenStream, index int32) Token {
	switch index {
	case 0:
		return source.First
	case 1:
		return source.Second
	case 2:
		return source.Third
	case 3:
		return source.Fourth
	default:
		return Token{Kind: Symbol, Span: source.SourceSpan}
	}
}

func SyntheticDeclarationKind(seed int32) TokenKind {
	switch seed % 4 {
	case 0:
		return TypeKw
	case 1:
		return ConstKw
	case 2:
		return FnKw
	default:
		return LetKw
	}
}

func SyntheticExpressionKind(seed int32) TokenKind {
	switch seed % 4 {
	case 0:
		return BoolLiteral
	case 1:
		return Identifier
	case 2:
		return NumberLiteral
	default:
		return LiteralType
	}
}

func GeneratedToken(kind TokenKind, start int32, width int32) Token {
	return Token{Kind: kind, Span: MakeSpan(start, start+width, 1, start+1)}
}

func StreamFromSeed(seed int32) TokenStream {
	return StreamFromSource(SourceFromSeed(seed))
}

func StreamFromSource(source SourceText) TokenStream {
	first := GeneratedToken(SyntheticDeclarationKind(SourceCodeAt(source, 0)), SourceOffsetAt(source, 0), 2)
	second := GeneratedToken(Identifier, SourceOffsetAt(source, 1), 4)
	third := GeneratedToken(SyntheticExpressionKind(SourceCodeAt(source, 2)), SourceOffsetAt(source, 2), 3)
	fourth := TokenOrSymbol(LexSourceAt(source, 3))
	return MakeTokenStream(first, second, third, fourth)
}

func StreamScore(source TokenStream) int32 {
	return TokenScore(source.First) +
		TokenScore(source.Second) +
		TokenScore(source.Third) +
		TokenScore(source.Fourth) +
		SpanWidth(source.SourceSpan)
}

func SeverityScore(severity Severity) int32 {
	switch severity {
	case SeverityError:
		return 100
	case SeverityWarning:
		return 10
	default:
		return 1
	}
}

func CodeScore(code DiagnosticCode) int32 {
	switch code {
	case CodeUnexpectedEnd:
		return 11
	case CodeUnexpectedToken:
		return 13
	case CodeAmbiguousParse:
		return 17
	case CodeUnknownSymbol:
		return 19
	case CodeTypeMismatch:
		return 23
	case CodeMissingModule:
		return 29
	default:
		return 17
	}
}

func MakeDiagnostic(
	code DiagnosticCode,
	severity Severity,
	sourceSpan Span,
	primary int32,
	secondary int32,
) Diagnostic {
	return Diagnostic{
		Code:      code,
		Severity:  severity,
		Span:      sourceSpan,
		Primary:   primary,
		Secondary: secondary,
	}
}

func PlaceholderDiagnostic() Diagnostic {
	return MakeDiagnostic(CodeUnexpectedEnd, SeverityNote, MakeSpan(0, 0, 0, 0), 0, 0)
}

func EmptyDiagnosticBag() DiagnosticBag {
	placeholder := PlaceholderDiagnostic()
	return DiagnosticBag{
		First:      placeholder,
		Second:     placeholder,
		Count:      0,
		ErrorCount: 0,
	}
}

func SeverityErrorCount(severity Severity) int32 {
	if severity == SeverityError {
		return 1
	}
	return 0
}

func PushDiagnostic(bag DiagnosticBag, diagnostic Diagnostic) DiagnosticBag {
	switch bag.Count {
	case 0:
		return DiagnosticBag{
			First:      diagnostic,
			Second:     bag.Second,
			Count:      1,
			ErrorCount: bag.ErrorCount + SeverityErrorCount(diagnostic.Severity),
		}
	case 1:
		return DiagnosticBag{
			First:      bag.First,
			Second:     diagnostic,
			Count:      2,
			ErrorCount: bag.ErrorCount + SeverityErrorCount(diagnostic.Severity),
		}
	default:
		return DiagnosticBag{
			First:      bag.First,
			Second:     bag.Second,
			Count:      bag.Count + 1,
			ErrorCount: bag.ErrorCount + SeverityErrorCount(diagnostic.Severity),
		}
	}
}

func CodeFromParseError(error ParseError) DiagnosticCode {
	switch ParseErrorTag(error) {
	case 1:
		return CodeUnexpectedEnd
	case 2:
		return CodeUnexpectedToken
	default:
		return CodeAmbiguousParse
	}
}

func DiagnosticFromParseError(error ParseError) Diagnostic {
	return MakeDiagnostic(
		CodeFromParseError(error),
		SeverityError,
		ParseErrorSpan(error),
		ParseErrorExpected(error),
		ParseErrorActual(error),
	)
}

func DiagnosticScore(diagnostic Diagnostic) int32 {
	return CodeScore(diagnostic.Code) +
		SeverityScore(diagnostic.Severity) +
		SpanWidth(diagnostic.Span) +
		diagnostic.Primary -
		diagnostic.Secondary
}

func DiagnosticBagScore(bag DiagnosticBag) int32 {
	return DiagnosticScore(bag.First) +
		DiagnosticScore(bag.Second) +
		bag.Count +
		bag.ErrorCount
}

func MergeDiagnosticBags(left DiagnosticBag, right DiagnosticBag) DiagnosticBag {
	switch right.Count {
	case 0:
		return left
	case 1:
		return PushDiagnostic(left, right.First)
	default:
		return PushDiagnostic(PushDiagnostic(left, right.First), right.Second)
	}
}

func UnknownType() Type {
	return Type{Kind: TypeUnknown}
}

func I32Type() Type {
	return Type{Kind: TypeI32}
}

func BoolType() Type {
	return Type{Kind: TypeBool}
}

func ErrorType() Type {
	return Type{Kind: TypeError}
}

func FunctionType(paramCount int32, result Type) Type {
	return Type{Kind: TypeFunction, ParamCount: paramCount, Result: TypeTag(result)}
}

func ProductType(fieldCount int32) Type {
	return Type{Kind: TypeProduct, FieldCount: fieldCount}
}

func TypeTag(valueType Type) int32 {
	switch valueType.Kind {
	case TypeUnknown:
		return 0
	case TypeI32:
		return 1
	case TypeBool:
		return 2
	case TypeFunction:
		return 3
	case TypeProduct:
		return 4
	default:
		return 5
	}
}

func TypePayload(valueType Type) int32 {
	switch valueType.Kind {
	case TypeFunction:
		return valueType.ParamCount + valueType.Result
	case TypeProduct:
		return valueType.FieldCount
	default:
		return 0
	}
}

func TypeScore(valueType Type) int32 {
	return TypeTag(valueType)*31 + TypePayload(valueType)
}

func SameType(left Type, right Type) bool {
	if TypeTag(left) == TypeTag(right) {
		return TypePayload(left) == TypePayload(right)
	}
	return false
}

func TypeFromSymbol(name int32) Type {
	switch name % 5 {
	case 0:
		return I32Type()
	case 1:
		return BoolType()
	case 2:
		return ProductType(2)
	case 3:
		return FunctionType(1, I32Type())
	default:
		return UnknownType()
	}
}

func MakeSymbol(name int32, valueType Type) CheckSymbol {
	return CheckSymbol{Name: name, ValueType: valueType}
}

func PlaceholderSymbol() CheckSymbol {
	return MakeSymbol(0, UnknownType())
}

func EmptyCheckEnv() CheckEnv {
	return CheckEnv{
		First:       PlaceholderSymbol(),
		Second:      PlaceholderSymbol(),
		Count:       0,
		Diagnostics: EmptyDiagnosticBag(),
	}
}

func DefineSymbol(env CheckEnv, name int32, valueType Type) CheckEnv {
	next := MakeSymbol(name, valueType)
	switch env.Count {
	case 0:
		return CheckEnv{
			First:       next,
			Second:      env.Second,
			Count:       1,
			Diagnostics: env.Diagnostics,
		}
	case 1:
		return CheckEnv{
			First:       env.First,
			Second:      next,
			Count:       2,
			Diagnostics: env.Diagnostics,
		}
	default:
		return CheckEnv{
			First:       env.First,
			Second:      env.Second,
			Count:       env.Count + 1,
			Diagnostics: env.Diagnostics,
		}
	}
}

func SeedCheckEnv(seed int32) CheckEnv {
	return DefineSymbol(
		DefineSymbol(EmptyCheckEnv(), seed, I32Type()),
		seed+1,
		BoolType(),
	)
}

func LookupType(env CheckEnv, name int32) Type {
	switch env.Count {
	case 0:
		return UnknownType()
	case 1:
		if env.First.Name == name {
			return env.First.ValueType
		}
		return UnknownType()
	default:
		if env.First.Name == name {
			return env.First.ValueType
		}
		if env.Second.Name == name {
			return env.Second.ValueType
		}
		return UnknownType()
	}
}

func UnknownSymbolDiagnostic(name int32, sourceSpan Span) Diagnostic {
	return MakeDiagnostic(CodeUnknownSymbol, SeverityError, sourceSpan, name, 0)
}

func TypeMismatchDiagnostic(expected Type, actual Type, sourceSpan Span) Diagnostic {
	return MakeDiagnostic(CodeTypeMismatch, SeverityError, sourceSpan, TypeTag(expected), TypeTag(actual))
}

func KeywordWeight(kind TokenKind) int32 {
	switch kind {
	case Import:
		return 11
	case External:
		return 13
	case TypeKw:
		return 17
	case ConstKw:
		return 19
	case FnKw:
		return 23
	case LetKw:
		return 29
	case MatchKw:
		return 31
	case PubKw:
		return 37
	case BoolLiteral:
		return 41
	case Identifier:
		return 43
	case NumberLiteral:
		return 47
	case StringLiteral:
		return 53
	case CharLiteral:
		return 59
	case MultilineLiteral:
		return 61
	case LiteralType:
		return 67
	default:
		return 71
	}
}

func TokenScore(token Token) int32 {
	return KeywordWeight(token.Kind) +
		SpanWidth(token.Span) +
		DeclarationKindScore(DeclarationKindOf(token.Kind)) +
		ExpressionKindScore(ExpressionKindOf(token.Kind))
}

func DeclarationKindOf(kind TokenKind) DeclarationKind {
	switch kind {
	case FnKw:
		return FunctionDeclaration
	case LetKw:
		return LetDeclaration
	case ConstKw:
		return ConstDeclaration
	case TypeKw:
		return TypeDeclaration
	default:
		return NoDeclaration
	}
}

func ExpressionKindOf(kind TokenKind) ExpressionKind {
	switch kind {
	case NumberLiteral:
		return NumberExpression
	case BoolLiteral:
		return BooleanExpression
	case Identifier:
		return NameExpression
	case LiteralType:
		return NameExpression
	case StringLiteral:
		return TextExpression
	case CharLiteral:
		return TextExpression
	case MultilineLiteral:
		return TextExpression
	default:
		return NoExpression
	}
}

func DeclarationKindScore(kind DeclarationKind) int32 {
	switch kind {
	case FunctionDeclaration:
		return 1
	case LetDeclaration:
		return 2
	case ConstDeclaration:
		return 3
	case TypeDeclaration:
		return 4
	default:
		return 0
	}
}

func ExpressionKindScore(kind ExpressionKind) int32 {
	switch kind {
	case NumberExpression:
		return 1
	case BooleanExpression:
		return 2
	case NameExpression:
		return 3
	case TextExpression:
		return 4
	default:
		return 0
	}
}

func IsDeclarationKind(kind DeclarationKind) bool {
	return kind != NoDeclaration
}

func IsExpressionKind(kind ExpressionKind) bool {
	return kind != NoExpression
}

func IsSymbol(kind TokenKind) bool {
	return kind == Symbol
}

type ExprKind int32

const (
	MissingExpr ExprKind = iota
	IntLiteralExpr
	BoolLiteralExpr
	VarExpr
	BinaryExpr
	CallExpr
)

type Expr struct {
	Kind  ExprKind
	A     int32
	B     int32
	C     int32
	Value bool
}

func IntExpr(value int32) Expr {
	return Expr{Kind: IntLiteralExpr, A: value}
}

func BoolExpr(value bool) Expr {
	return Expr{Kind: BoolLiteralExpr, Value: value}
}

func VarExprOf(name int32) Expr {
	return Expr{Kind: VarExpr, A: name}
}

func BinaryExprOf(left int32, op int32, right int32) Expr {
	return Expr{Kind: BinaryExpr, A: left, B: op, C: right}
}

func CallExprOf(callee int32, arg int32) Expr {
	return Expr{Kind: CallExpr, A: callee, B: arg}
}

func ExprScore(expr Expr) int32 {
	switch expr.Kind {
	case IntLiteralExpr:
		return expr.A
	case BoolLiteralExpr:
		if expr.Value {
			return 1
		}
		return 0
	case VarExpr:
		return expr.A
	case BinaryExpr:
		return expr.A + expr.B + expr.C
	case CallExpr:
		return expr.A + expr.B + 5
	default:
		return 0
	}
}

func ExprTag(expr Expr) int32 {
	switch expr.Kind {
	case IntLiteralExpr:
		return 1
	case BoolLiteralExpr:
		return 2
	case VarExpr:
		return 3
	case BinaryExpr:
		return 4
	case CallExpr:
		return 5
	default:
		return 0
	}
}

func ExprFirst(expr Expr) int32 {
	switch expr.Kind {
	case IntLiteralExpr:
		return expr.A
	case BoolLiteralExpr:
		if expr.Value {
			return 1
		}
		return 0
	case VarExpr:
		return expr.A
	case BinaryExpr:
		return expr.A
	case CallExpr:
		return expr.A
	default:
		return 0
	}
}

func ExprSecond(expr Expr) int32 {
	if expr.Kind == BinaryExpr {
		return expr.B
	}
	if expr.Kind == CallExpr {
		return expr.B
	}
	return 0
}

func ExprThird(expr Expr) int32 {
	if expr.Kind == BinaryExpr {
		return expr.C
	}
	return 0
}

type DeclKind int32

const (
	FnDecl DeclKind = iota
	LetDecl
	ConstDecl
	TypeDecl
	SourceImportDecl
)

type TypeAnnotationKind int32

const (
	MissingTypeAnnotation TypeAnnotationKind = iota
	NamedTypeAnnotation
	AppliedTypeAnnotation
)

type TypeAnnotation struct {
	Kind TypeAnnotationKind
	Name int32
	Arg  int32
}

func MissingTypeAnnotationOf() TypeAnnotation {
	return TypeAnnotation{Kind: MissingTypeAnnotation}
}

func NamedType(name int32) TypeAnnotation {
	return TypeAnnotation{Kind: NamedTypeAnnotation, Name: name}
}

func AppliedType(constructor int32, arg int32) TypeAnnotation {
	return TypeAnnotation{Kind: AppliedTypeAnnotation, Name: constructor, Arg: arg}
}

func TypeAnnotationScore(annotation TypeAnnotation) int32 {
	switch annotation.Kind {
	case NamedTypeAnnotation:
		return annotation.Name
	case AppliedTypeAnnotation:
		return annotation.Name + annotation.Arg + 7
	default:
		return 0
	}
}

func TypeAnnotationName(annotation TypeAnnotation) int32 {
	switch annotation.Kind {
	case NamedTypeAnnotation:
		return annotation.Name
	case AppliedTypeAnnotation:
		return annotation.Name
	default:
		return 0
	}
}

type Decl struct {
	Kind       DeclKind
	Name       int32
	ParamCount int32
	Annotation TypeAnnotation
	Value      Expr
}

type Program struct {
	ModuleName       int32
	DeclarationCount int32
	EntryDecl        Decl
	SecondaryDecl    Decl
	Span             Span
}

func FnDeclOf(name int32, paramCount int32, returnType TypeAnnotation, value Expr) Decl {
	return Decl{Kind: FnDecl, Name: name, ParamCount: paramCount, Annotation: returnType, Value: value}
}

func LetDeclOf(name int32, annotation TypeAnnotation, value Expr) Decl {
	return Decl{Kind: LetDecl, Name: name, Annotation: annotation, Value: value}
}

func EmptyDecl() Decl {
	return Decl{Kind: SourceImportDecl}
}

func ProgramOf(moduleName int32, declarationCount int32, entry Decl, secondary Decl, span Span) Program {
	return Program{
		ModuleName:       moduleName,
		DeclarationCount: declarationCount,
		EntryDecl:        entry,
		SecondaryDecl:    secondary,
		Span:             span,
	}
}

func DeclScore(decl Decl) int32 {
	switch decl.Kind {
	case FnDecl:
		return decl.Name + decl.ParamCount + TypeAnnotationScore(decl.Annotation) + ExprScore(decl.Value)
	case LetDecl:
		return decl.Name + TypeAnnotationScore(decl.Annotation) + ExprScore(decl.Value)
	case ConstDecl:
		return decl.Name + TypeAnnotationScore(decl.Annotation) + ExprScore(decl.Value) + 3
	case TypeDecl:
		return decl.Name + decl.ParamCount
	default:
		return decl.Name + TypeAnnotationScore(decl.Annotation)
	}
}

func ProgramScore(program Program) int32 {
	return program.ModuleName +
		program.DeclarationCount +
		DeclScore(program.EntryDecl) +
		DeclScore(program.SecondaryDecl) +
		SpanWidth(program.Span)
}

func DeclTag(decl Decl) int32 {
	switch decl.Kind {
	case FnDecl:
		return 1
	case LetDecl:
		return 2
	case ConstDecl:
		return 3
	case TypeDecl:
		return 4
	default:
		return 5
	}
}

func DeclName(decl Decl) int32 {
	return decl.Name
}

func DeclParamCount(decl Decl) int32 {
	return decl.ParamCount
}

func DeclTypeName(decl Decl) int32 {
	if decl.Kind == TypeDecl {
		return decl.Name
	}
	return TypeAnnotationName(decl.Annotation)
}

func DeclValueExpr(decl Decl) Expr {
	switch decl.Kind {
	case FnDecl:
		return decl.Value
	case LetDecl:
		return decl.Value
	case ConstDecl:
		return decl.Value
	default:
		return Expr{Kind: MissingExpr}
	}
}

func DeclarationFromToken(kind TokenKind, seed int32) Decl {
	return DeclarationFromKind(DeclarationKindOf(kind), seed)
}

func DeclarationFromKind(kind DeclarationKind, seed int32) Decl {
	switch kind {
	case FunctionDeclaration:
		return FnDeclOf(seed, 1, NamedType(seed+1), IntExpr(seed+2))
	case LetDeclaration:
		return LetDeclOf(seed, NamedType(seed+1), VarExprOf(seed+2))
	case ConstDeclaration:
		return Decl{Kind: ConstDecl, Name: seed, Annotation: NamedType(seed + 1), Value: BoolExpr(true)}
	case TypeDeclaration:
		return Decl{Kind: TypeDecl, Name: seed, ParamCount: 1}
	default:
		return Decl{Kind: SourceImportDecl, Name: seed, Annotation: NamedType(seed + 1)}
	}
}

func PrimaryExprFromKind(kind ExpressionKind, seed int32, currentToken Token) Expr {
	switch kind {
	case NumberExpression:
		return IntExpr(seed + TokenScore(currentToken))
	case BooleanExpression:
		return BoolExpr(seed%2 == 0)
	case NameExpression:
		return VarExprOf(seed + TokenScore(currentToken))
	case TextExpression:
		return VarExprOf(seed + SpanWidth(currentToken.Span))
	default:
		return Expr{Kind: MissingExpr}
	}
}

func ParsePrimary(current ParseState, source TokenStream, seed int32) ExprParseResult {
	currentToken := TokenAt(source, current.Cursor)
	kind := ExpressionKindOf(currentToken.Kind)
	if !IsExpressionKind(kind) {
		return ExprParseResult{
			Ok:    false,
			Error: ParseError{Kind: UnexpectedToken, Expected: 2, Actual: 0, At: currentToken.Span},
		}
	}
	return ExprParseResult{
		Ok:    true,
		State: ParseState{Cursor: current.Cursor + 1, Limit: current.Limit},
		Value: ExprFrame{
			Expr:     PrimaryExprFromKind(kind, seed, currentToken),
			Consumed: 1,
		},
	}
}

func CombineBinary(left ExprParseResult, op Token, right ExprParseResult) ExprParseResult {
	if !right.Ok {
		return right
	}
	return ExprParseResult{
		Ok:    true,
		State: right.State,
		Value: ExprFrame{
			Expr: BinaryExprOf(
				ExprScore(left.Value.Expr),
				TokenScore(op),
				ExprScore(right.Value.Expr),
			),
			Consumed: left.Value.Consumed + 1 + right.Value.Consumed,
		},
	}
}

func ParseBinaryTail(result ExprParseResult, source TokenStream, seed int32) ExprParseResult {
	if !result.Ok {
		return result
	}
	op := TokenAt(source, result.State.Cursor)
	hasRHS := result.State.Cursor+1 < result.State.Limit
	canParseBinary := IsSymbol(op.Kind) && hasRHS
	if canParseBinary {
		right := ParsePrimary(State(result.State.Cursor+1, result.State.Limit), source, seed+1)
		return CombineBinary(result, op, right)
	}
	return result
}

func ParseExpression(current ParseState, source TokenStream, seed int32) ExprParseResult {
	return ParseBinaryTail(ParsePrimary(current, source, seed), source, seed)
}

func ParseTextPrimary(current ParseState, source TextTokenStream, seed int32) ExprParseResult {
	currentToken := TextTokenAt(source, current.Cursor)
	kind := ExpressionKindOf(currentToken.Kind)
	if !IsExpressionKind(kind) {
		return ExprParseResult{
			Ok:    false,
			Error: ParseError{Kind: UnexpectedToken, Expected: 2, Actual: 0, At: currentToken.Span},
		}
	}
	return ExprParseResult{
		Ok:    true,
		State: ParseState{Cursor: current.Cursor + 1, Limit: current.Limit},
		Value: ExprFrame{
			Expr:     PrimaryExprFromKind(kind, seed, currentToken),
			Consumed: 1,
		},
	}
}

func TextExprPunctuationError(
	source TextTokenStream,
	index int32,
	expected TextPunct,
) ExprParseResult {
	current := TextTokenAt(source, index)
	actual := TextPunctuationAt(source, index)
	return ExprParseResult{
		Ok: false,
		Error: ParseError{
			Kind:     UnexpectedToken,
			Expected: TextPunctuationScore(expected),
			Actual:   TextPunctuationScore(actual),
			At:       current.Span,
		},
	}
}

func CombineCall(callee ExprParseResult, arg ExprParseResult, closeIndex int32) ExprParseResult {
	if !arg.Ok {
		return arg
	}
	return ExprParseResult{
		Ok:    true,
		State: State(closeIndex+1, callee.State.Limit),
		Value: ExprFrame{
			Expr: CallExprOf(
				ExprScore(callee.Value.Expr),
				ExprScore(arg.Value.Expr),
			),
			Consumed: callee.Value.Consumed + arg.Value.Consumed + 2,
		},
	}
}

func ParseTextCallTail(result ExprParseResult, source TextTokenStream, seed int32) ExprParseResult {
	if !result.Ok {
		return result
	}
	openIndex := result.State.Cursor
	closeIndex := result.State.Cursor + 2
	if !TextPunctuationMatches(source, openIndex, PunctLeftParen) {
		return result
	}
	if !TextPunctuationMatches(source, closeIndex, PunctRightParen) {
		return TextExprPunctuationError(source, closeIndex, PunctRightParen)
	}
	arg := ParseTextPrimary(State(openIndex+1, closeIndex), source, seed+1)
	return CombineCall(result, arg, closeIndex)
}

func ParseTextBinaryTail(result ExprParseResult, source TextTokenStream, seed int32) ExprParseResult {
	if !result.Ok {
		return result
	}
	op := TextTokenAt(source, result.State.Cursor)
	hasRHS := result.State.Cursor+1 < result.State.Limit
	canParseBinary := IsSymbol(op.Kind) && hasRHS
	if canParseBinary {
		right := ParseTextPrimary(State(result.State.Cursor+1, result.State.Limit), source, seed+1)
		return CombineBinary(result, op, right)
	}
	return result
}

func ParseTextExpression(current ParseState, source TextTokenStream, seed int32) ExprParseResult {
	return ParseTextBinaryTail(
		ParseTextCallTail(ParseTextPrimary(current, source, seed), source, seed),
		source,
		seed,
	)
}

func DeclarationFromExpr(kind DeclarationKind, seed int32, value Expr) Decl {
	switch kind {
	case FunctionDeclaration:
		return FnDeclOf(seed, 1, NamedType(seed+1), value)
	case LetDeclaration:
		return LetDeclOf(seed, NamedType(seed+1), value)
	case ConstDeclaration:
		return Decl{Kind: ConstDecl, Name: seed, Annotation: NamedType(seed + 1), Value: value}
	case TypeDeclaration:
		return Decl{Kind: TypeDecl, Name: seed, ParamCount: 1}
	default:
		return Decl{Kind: SourceImportDecl, Name: seed, Annotation: NamedType(seed + 1)}
	}
}

func DeclarationFromNamedExpr(kind DeclarationKind, name Token, seed int32, value Expr) Decl {
	switch kind {
	case FunctionDeclaration:
		return FnDeclOf(TokenScore(name), 1, NamedType(seed+1), value)
	case LetDeclaration:
		return LetDeclOf(TokenScore(name), NamedType(seed+1), value)
	case ConstDeclaration:
		return Decl{Kind: ConstDecl, Name: TokenScore(name), Annotation: NamedType(seed + 1), Value: value}
	case TypeDeclaration:
		return Decl{Kind: TypeDecl, Name: TokenScore(name), ParamCount: 1}
	default:
		return Decl{Kind: SourceImportDecl, Name: seed, Annotation: NamedType(TokenScore(name))}
	}
}

func DeclarationFromNamedAnnotatedExpr(
	kind DeclarationKind,
	name Token,
	annotation TypeAnnotation,
	seed int32,
	value Expr,
) Decl {
	switch kind {
	case FunctionDeclaration:
		return FnDeclOf(TokenScore(name), 1, annotation, value)
	case LetDeclaration:
		return LetDeclOf(TokenScore(name), annotation, value)
	case ConstDeclaration:
		return Decl{Kind: ConstDecl, Name: TokenScore(name), Annotation: annotation, Value: value}
	case TypeDeclaration:
		return Decl{Kind: TypeDecl, Name: TokenScore(name), ParamCount: 1}
	default:
		return Decl{Kind: SourceImportDecl, Name: seed, Annotation: NamedType(TokenScore(name))}
	}
}

func DeclarationFromExprResult(kind DeclarationKind, start int32, seed int32, parsed ExprParseResult) ParseResult {
	if !parsed.Ok {
		return ParseResult{Ok: false, Error: parsed.Error}
	}
	return ParseResult{
		Ok:    true,
		State: parsed.State,
		Value: DeclFrame{
			Decl:     DeclarationFromExpr(kind, seed, parsed.Value.Expr),
			Consumed: parsed.State.Cursor - start,
		},
	}
}

func DeclarationFromNamedResult(
	kind DeclarationKind,
	name Token,
	start int32,
	seed int32,
	parsed ExprParseResult,
) ParseResult {
	if !parsed.Ok {
		return ParseResult{Ok: false, Error: parsed.Error}
	}
	return ParseResult{
		Ok:    true,
		State: parsed.State,
		Value: DeclFrame{
			Decl:     DeclarationFromNamedExpr(kind, name, seed, parsed.Value.Expr),
			Consumed: parsed.State.Cursor - start,
		},
	}
}

func DeclarationFromNamedAnnotatedResult(
	kind DeclarationKind,
	name Token,
	start int32,
	annotation TypeAnnotation,
	seed int32,
	parsed ExprParseResult,
) ParseResult {
	if !parsed.Ok {
		return ParseResult{Ok: false, Error: parsed.Error}
	}
	return ParseResult{
		Ok:    true,
		State: parsed.State,
		Value: DeclFrame{
			Decl: DeclarationFromNamedAnnotatedExpr(
				kind,
				name,
				annotation,
				seed,
				parsed.Value.Expr,
			),
			Consumed: parsed.State.Cursor - start,
		},
	}
}

func TextPunctuationMatches(
	source TextTokenStream,
	index int32,
	expected TextPunct,
) bool {
	return TextPunctuationScore(TextPunctuationAt(source, index)) == TextPunctuationScore(expected)
}

func TextPunctuationError(
	source TextTokenStream,
	index int32,
	expected TextPunct,
) ParseResult {
	current := TextTokenAt(source, index)
	actual := TextPunctuationAt(source, index)
	return ParseResult{
		Ok: false,
		Error: ParseError{
			Kind:     UnexpectedToken,
			Expected: TextPunctuationScore(expected),
			Actual:   TextPunctuationScore(actual),
			At:       current.Span,
		},
	}
}

func TextParamPunctuationError(
	source TextTokenStream,
	index int32,
	expected TextPunct,
) ParamParseResult {
	current := TextTokenAt(source, index)
	actual := TextPunctuationAt(source, index)
	return ParamParseResult{
		Ok: false,
		Error: ParseError{
			Kind:     UnexpectedToken,
			Expected: TextPunctuationScore(expected),
			Actual:   TextPunctuationScore(actual),
			At:       current.Span,
		},
	}
}

func IsTypeAnnotationAtom(current Token) bool {
	return ExpressionKindOf(current.Kind) == NameExpression
}

func TypeAnnotationError(current Token) TypeAnnotationParseResult {
	return TypeAnnotationParseResult{
		Ok: false,
		Error: ParseError{
			Kind:     UnexpectedToken,
			Expected: 4,
			Actual:   TokenScore(current),
			At:       current.Span,
		},
	}
}

func TextAnnotationPunctuationError(
	source TextTokenStream,
	index int32,
	expected TextPunct,
) TypeAnnotationParseResult {
	current := TextTokenAt(source, index)
	actual := TextPunctuationAt(source, index)
	return TypeAnnotationParseResult{
		Ok: false,
		Error: ParseError{
			Kind:     UnexpectedToken,
			Expected: TextPunctuationScore(expected),
			Actual:   TextPunctuationScore(actual),
			At:       current.Span,
		},
	}
}

func ParseTextAppliedTypeArg(
	name Token,
	current ParseState,
	source TextTokenStream,
) TypeAnnotationParseResult {
	arg := TextTokenAt(source, current.Cursor+2)
	if !IsTypeAnnotationAtom(arg) {
		return TypeAnnotationError(arg)
	}
	if !TextPunctuationMatches(source, current.Cursor+3, PunctRightParen) {
		return TextAnnotationPunctuationError(source, current.Cursor+3, PunctRightParen)
	}
	return TypeAnnotationParseResult{
		Ok:    true,
		State: State(current.Cursor+4, current.Limit),
		Value: TypeAnnotationFrame{
			Annotation: AppliedType(TokenScore(name), TokenScore(arg)),
			Consumed:   4,
		},
	}
}

func ParseTextTypeApplyTail(
	name Token,
	current ParseState,
	source TextTokenStream,
) TypeAnnotationParseResult {
	if TextPunctuationMatches(source, current.Cursor+1, PunctLeftParen) {
		return ParseTextAppliedTypeArg(name, current, source)
	}
	return TypeAnnotationParseResult{
		Ok:    true,
		State: State(current.Cursor+1, current.Limit),
		Value: TypeAnnotationFrame{
			Annotation: NamedType(TokenScore(name)),
			Consumed:   1,
		},
	}
}

func ParseTextTypeAnnotation(
	current ParseState,
	source TextTokenStream,
) TypeAnnotationParseResult {
	name := TextTokenAt(source, current.Cursor)
	if !IsTypeAnnotationAtom(name) {
		return TypeAnnotationError(name)
	}
	return ParseTextTypeApplyTail(name, current, source)
}

func ParseTextParam(current ParseState, source TextTokenStream) ParamParseResult {
	name := TextTokenAt(source, current.Cursor)
	if !TextPunctuationMatches(source, current.Cursor+1, PunctColon) {
		return TextParamPunctuationError(source, current.Cursor+1, PunctColon)
	}
	annotation := ParseTextTypeAnnotation(State(current.Cursor+2, current.Limit), source)
	if !annotation.Ok {
		return ParamParseResult{Ok: false, Error: annotation.Error}
	}
	return ParamParseResult{
		Ok:    true,
		State: annotation.State,
		Value: ParamFrame{
			Name:       TokenScore(name),
			Annotation: annotation.Value.Annotation,
			Consumed:   annotation.Value.Consumed + 2,
		},
	}
}

func PushTextParamFrame(
	current ParamListFrame,
	param ParamFrame,
	separatorWidth int32,
) ParamListFrame {
	return ParamListFrame{
		Count:    current.Count + 1,
		Consumed: current.Consumed + param.Consumed + separatorWidth,
	}
}

func ParseTextParamList(current ParseState, source TextTokenStream) ParamListParseResult {
	params := ParamListFrame{}
	state := current
	for {
		if TextPunctuationMatches(source, state.Cursor, PunctRightParen) {
			return ParamListParseResult{Ok: true, State: state, Value: params}
		}
		param := ParseTextParam(state, source)
		if !param.Ok {
			return ParamListParseResult{Ok: false, Error: param.Error}
		}
		params = PushTextParamFrame(params, param.Value, 0)
		state = param.State
		if !TextPunctuationMatches(source, state.Cursor, PunctComma) {
			return ParamListParseResult{Ok: true, State: state, Value: params}
		}
		params.Consumed += 1
		state = State(state.Cursor+1, state.Limit)
	}
}

func FindTextPunctuation(source TextTokenStream, index int32, limit int32, expected TextPunct) int32 {
	for index < limit {
		if TextPunctuationMatches(source, index, expected) {
			return index
		}
		index += 1
	}
	return limit
}

func ParseTextFunctionTail(current ParseState, source TextTokenStream, seed int32) ParseResult {
	name := TextTokenAt(source, current.Cursor+1)
	if !TextPunctuationMatches(source, current.Cursor+2, PunctLeftParen) {
		return TextPunctuationError(source, current.Cursor+2, PunctLeftParen)
	}
	params := ParseTextParamList(State(current.Cursor+3, current.Limit), source)
	if !params.Ok {
		return ParseResult{Ok: false, Error: params.Error}
	}
	if !TextPunctuationMatches(source, params.State.Cursor, PunctRightParen) {
		return TextPunctuationError(source, params.State.Cursor, PunctRightParen)
	}
	afterParams := State(params.State.Cursor+1, current.Limit)
	if !TextPunctuationMatches(source, afterParams.Cursor, PunctArrow) {
		return TextPunctuationError(source, afterParams.Cursor, PunctArrow)
	}
	returnType := ParseTextTypeAnnotation(State(afterParams.Cursor+1, current.Limit), source)
	if !returnType.Ok {
		return ParseResult{Ok: false, Error: returnType.Error}
	}
	if !TextPunctuationMatches(source, returnType.State.Cursor, PunctLeftBrace) {
		return TextPunctuationError(source, returnType.State.Cursor, PunctLeftBrace)
	}
	bodyStart := returnType.State.Cursor + 1
	closeIndex := FindTextPunctuation(source, bodyStart, current.Limit, PunctRightBrace)
	body := ParseTextExpression(State(bodyStart, closeIndex), source, seed)
	if !body.Ok {
		return ParseResult{Ok: false, Error: body.Error}
	}
	if !TextPunctuationMatches(source, body.State.Cursor, PunctRightBrace) {
		return TextPunctuationError(source, body.State.Cursor, PunctRightBrace)
	}
	next := State(body.State.Cursor+1, current.Limit)
	return ParseResult{
		Ok:    true,
		State: next,
		Value: DeclFrame{
			Decl:     FnDeclOf(TokenScore(name), params.Value.Count, returnType.Value.Annotation, body.Value.Expr),
			Consumed: next.Cursor - current.Cursor,
		},
	}
}

func ParseTextPubFunctionTail(current ParseState, source TextTokenStream, seed int32) ParseResult {
	parsed := ParseTextFunctionTail(State(current.Cursor+1, current.Limit), source, seed)
	if !parsed.Ok {
		return parsed
	}
	parsed.Value.Consumed += 1
	return parsed
}

func ParseTextValueTail(
	kind DeclarationKind,
	current ParseState,
	source TextTokenStream,
	seed int32,
) ParseResult {
	name := TextTokenAt(source, current.Cursor+1)
	if TextPunctuationMatches(source, current.Cursor+2, PunctColon) {
		annotation := ParseTextTypeAnnotation(State(current.Cursor+3, current.Limit), source)
		if !annotation.Ok {
			return ParseResult{Ok: false, Error: annotation.Error}
		}
		return ParseTextValueBody(
			kind,
			name,
			current.Cursor,
			annotation.Value.Annotation,
			seed,
			source,
			annotation.State.Cursor,
		)
	}
	return ParseTextValueBody(
		kind,
		name,
		current.Cursor,
		MissingTypeAnnotationOf(),
		seed,
		source,
		current.Cursor+2,
	)
}

func ValueExpressionLimit(equalIndex int32) int32 {
	return equalIndex + 2
}

func ParseTextValueBody(
	kind DeclarationKind,
	name Token,
	start int32,
	annotation TypeAnnotation,
	seed int32,
	source TextTokenStream,
	equalIndex int32,
) ParseResult {
	if !TextPunctuationMatches(source, equalIndex, PunctEqual) {
		return TextPunctuationError(source, equalIndex, PunctEqual)
	}
	return DeclarationFromNamedAnnotatedResult(
		kind,
		name,
		start,
		annotation,
		seed,
		ParseTextExpression(State(equalIndex+1, ValueExpressionLimit(equalIndex)), source, seed),
	)
}

func IsTextPubFunctionStart(source TextTokenStream, index int32) bool {
	first := TextTokenAt(source, index)
	if first.Kind != PubKw {
		return false
	}
	second := TextTokenAt(source, index+1)
	return second.Kind == FnKw
}

func IsTextDeclarationStart(source TextTokenStream, index int32) bool {
	first := TextTokenAt(source, index)
	kind := DeclarationKindOf(first.Kind)
	if IsDeclarationKind(kind) {
		return true
	}
	return IsTextPubFunctionStart(source, index)
}

func ParseTextDeclarationForKind(
	kind DeclarationKind,
	current ParseState,
	source TextTokenStream,
	seed int32,
) ParseResult {
	switch kind {
	case FunctionDeclaration:
		return ParseTextFunctionTail(current, source, seed)
	case LetDeclaration:
		return ParseTextValueTail(kind, current, source, seed)
	case ConstDeclaration:
		return ParseTextValueTail(kind, current, source, seed)
	case TypeDeclaration:
		return ParseTextValueTail(kind, current, source, seed)
	default:
		first := TextTokenAt(source, current.Cursor)
		return ParseResult{
			Ok:    false,
			Error: ParseError{Kind: UnexpectedToken, Expected: 1, Actual: 0, At: first.Span},
		}
	}
}

func ParseDeclaration(current ParseState, first Token, seed int32) ParseResult {
	kind := DeclarationKindOf(first.Kind)
	if !IsDeclarationKind(kind) {
		return ParseResult{
			Ok:    false,
			Error: ParseError{Kind: UnexpectedToken, Expected: 1, Actual: 0, At: first.Span},
		}
	}
	return ParseResult{
		Ok:    true,
		State: ParseState{Cursor: current.Cursor + 1, Limit: current.Limit},
		Value: DeclFrame{Decl: DeclarationFromToken(first.Kind, seed), Consumed: 1},
	}
}

func ParseDeclarationStream(current ParseState, source TokenStream, seed int32) ParseResult {
	first := TokenAt(source, current.Cursor)
	kind := DeclarationKindOf(first.Kind)
	if !IsDeclarationKind(kind) {
		return ParseResult{
			Ok:    false,
			Error: ParseError{Kind: UnexpectedToken, Expected: 1, Actual: 0, At: first.Span},
		}
	}
	return DeclarationFromExprResult(
		kind,
		current.Cursor,
		seed,
		ParseExpression(State(current.Cursor+2, source.Length), source, seed),
	)
}

func ParseTextDeclarationStream(current ParseState, source TextTokenStream, seed int32) ParseResult {
	first := TextTokenAt(source, current.Cursor)
	kind := DeclarationKindOf(first.Kind)
	if IsTextPubFunctionStart(source, current.Cursor) {
		return ParseTextPubFunctionTail(current, source, seed)
	}
	if !IsDeclarationKind(kind) {
		return ParseResult{
			Ok:    false,
			Error: ParseError{Kind: UnexpectedToken, Expected: 1, Actual: 0, At: first.Span},
		}
	}
	return ParseTextDeclarationForKind(kind, current, source, seed)
}

func CompleteTextProgram(
	moduleName int32,
	source TextTokenStream,
	first ParseResult,
	second ParseResult,
) ProgramParseResult {
	if !first.Ok {
		return ProgramParseResult{Ok: false, Error: first.Error}
	}
	if !second.Ok {
		return ProgramParseResult{
			Ok:    true,
			State: first.State,
			Value: ProgramFrame{
				Program: ProgramOf(
					moduleName,
					1,
					first.Value.Decl,
					EmptyDecl(),
					TextTokenStreamSpan(source),
				),
				Diagnostics: PushDiagnostic(
					EmptyDiagnosticBag(),
					DiagnosticFromParseError(second.Error),
				),
				Consumed: first.Value.Consumed,
			},
		}
	}
	return ProgramParseResult{
		Ok:    true,
		State: second.State,
		Value: ProgramFrame{
			Program: ProgramOf(
				moduleName,
				2,
				first.Value.Decl,
				second.Value.Decl,
				TextTokenStreamSpan(source),
			),
			Diagnostics: EmptyDiagnosticBag(),
			Consumed:    first.Value.Consumed + second.Value.Consumed,
		},
	}
}

func TextProgramFromFirst(
	moduleName int32,
	source TextTokenStream,
	seed int32,
	first ParseResult,
) ProgramParseResult {
	if !first.Ok {
		return ProgramParseResult{Ok: false, Error: first.Error}
	}
	if IsTextDeclarationStart(source, first.State.Cursor) {
		return CompleteTextProgram(
			moduleName,
			source,
			first,
			ParseTextDeclarationStream(first.State, source, seed+1),
		)
	}
	return ProgramParseResult{
		Ok:    true,
		State: first.State,
		Value: ProgramFrame{
			Program: ProgramOf(
				moduleName,
				1,
				first.Value.Decl,
				EmptyDecl(),
				TextTokenStreamSpan(source),
			),
			Diagnostics: EmptyDiagnosticBag(),
			Consumed:    first.Value.Consumed,
		},
	}
}

func ParseTextProgram(
	current ParseState,
	source TextTokenStream,
	moduleName int32,
	seed int32,
) ProgramParseResult {
	return TextProgramFromFirst(
		moduleName,
		source,
		seed,
		ParseTextDeclarationStream(current, source, seed),
	)
}

func ParseResultScore(result ParseResult) int32 {
	if result.Ok {
		return result.State.Cursor + result.Value.Consumed + DeclScore(result.Value.Decl)
	}
	return 0 - result.Error.Expected - SpanWidth(result.Error.At)
}

func ExprParseResultScore(result ExprParseResult) int32 {
	if result.Ok {
		return result.State.Cursor + result.Value.Consumed + ExprScore(result.Value.Expr)
	}
	return 0 - result.Error.Expected - SpanWidth(result.Error.At)
}

func ProgramFrameScore(frame ProgramFrame) int32 {
	return frame.Consumed + ProgramScore(frame.Program) + DiagnosticBagScore(frame.Diagnostics)
}

func ProgramParseResultScore(result ProgramParseResult) int32 {
	if result.Ok {
		return result.State.Cursor + ProgramFrameScore(result.Value)
	}
	return 0 - result.Error.Expected - SpanWidth(result.Error.At)
}

func ProgramFromParseOrFallback(result ProgramParseResult, fallback Program) Program {
	if result.Ok {
		return result.Value.Program
	}
	return fallback
}

func ParseDiagnosticScore(result ParseResult) int32 {
	if result.Ok {
		return DiagnosticBagScore(EmptyDiagnosticBag())
	}
	return DiagnosticBagScore(PushDiagnostic(
		EmptyDiagnosticBag(),
		DiagnosticFromParseError(result.Error),
	))
}

func MakeCheckedExpr(expr Expr, valueType Type, diagnostics DiagnosticBag) CheckedExpr {
	return CheckedExpr{Expr: expr, ValueType: valueType, Diagnostics: diagnostics}
}

func CheckVar(env CheckEnv, expr Expr, sourceSpan Span) CheckedExpr {
	name := ExprFirst(expr)
	valueType := LookupType(env, name)
	if TypeTag(valueType) == TypeTag(UnknownType()) {
		return MakeCheckedExpr(
			expr,
			ErrorType(),
			PushDiagnostic(env.Diagnostics, UnknownSymbolDiagnostic(name, sourceSpan)),
		)
	}
	return MakeCheckedExpr(expr, valueType, env.Diagnostics)
}

func BinaryOperandType(value int32) Type {
	if value >= 0 {
		return I32Type()
	}
	return ErrorType()
}

func CheckBinary(env CheckEnv, expr Expr, sourceSpan Span) CheckedExpr {
	leftType := BinaryOperandType(ExprFirst(expr))
	rightType := BinaryOperandType(ExprThird(expr))
	ok := false
	if SameType(leftType, I32Type()) {
		ok = SameType(rightType, I32Type())
	}
	if ok {
		return MakeCheckedExpr(expr, I32Type(), env.Diagnostics)
	}
	return MakeCheckedExpr(
		expr,
		ErrorType(),
		PushDiagnostic(env.Diagnostics, TypeMismatchDiagnostic(I32Type(), rightType, sourceSpan)),
	)
}

func CheckCall(env CheckEnv, expr Expr, sourceSpan Span) CheckedExpr {
	calleeType := BinaryOperandType(ExprFirst(expr))
	argType := BinaryOperandType(ExprSecond(expr))
	ok := false
	if SameType(calleeType, I32Type()) {
		ok = SameType(argType, I32Type())
	}
	if ok {
		return MakeCheckedExpr(expr, I32Type(), env.Diagnostics)
	}
	return MakeCheckedExpr(
		expr,
		ErrorType(),
		PushDiagnostic(env.Diagnostics, TypeMismatchDiagnostic(I32Type(), argType, sourceSpan)),
	)
}

func CheckExpr(env CheckEnv, expr Expr, sourceSpan Span) CheckedExpr {
	switch ExprTag(expr) {
	case 1:
		return MakeCheckedExpr(expr, I32Type(), env.Diagnostics)
	case 2:
		return MakeCheckedExpr(expr, BoolType(), env.Diagnostics)
	case 3:
		return CheckVar(env, expr, sourceSpan)
	case 4:
		return CheckBinary(env, expr, sourceSpan)
	case 5:
		return CheckCall(env, expr, sourceSpan)
	default:
		return MakeCheckedExpr(
			expr,
			ErrorType(),
			PushDiagnostic(env.Diagnostics, TypeMismatchDiagnostic(UnknownType(), ErrorType(), sourceSpan)),
		)
	}
}

func CheckExpected(checked CheckedExpr, expected Type, sourceSpan Span) DiagnosticBag {
	if SameType(checked.ValueType, expected) {
		return checked.Diagnostics
	}
	return PushDiagnostic(
		checked.Diagnostics,
		TypeMismatchDiagnostic(expected, checked.ValueType, sourceSpan),
	)
}

func MakeCheckedDecl(decl Decl, valueType Type, env CheckEnv) CheckedDecl {
	return CheckedDecl{Decl: decl, ValueType: valueType, Env: env}
}

func MakeCheckedProgram(
	program Program,
	entry CheckedDecl,
	secondary CheckedDecl,
	env CheckEnv,
) CheckedProgram {
	return CheckedProgram{
		Program:     program,
		Entry:       entry,
		Secondary:   secondary,
		Env:         env,
		Diagnostics: env.Diagnostics,
	}
}

func CheckValueDecl(env CheckEnv, decl Decl, sourceSpan Span) CheckedDecl {
	expected := TypeFromSymbol(DeclTypeName(decl))
	value := CheckExpr(env, DeclValueExpr(decl), sourceSpan)
	diagnostics := CheckExpected(value, expected, sourceSpan)
	nextEnv := DefineSymbol(
		CheckEnv{
			First:       env.First,
			Second:      env.Second,
			Count:       env.Count,
			Diagnostics: diagnostics,
		},
		DeclName(decl),
		expected,
	)
	return MakeCheckedDecl(decl, expected, nextEnv)
}

func CheckFunctionDecl(env CheckEnv, decl Decl, sourceSpan Span) CheckedDecl {
	expected := TypeFromSymbol(DeclTypeName(decl))
	body := CheckExpr(env, DeclValueExpr(decl), sourceSpan)
	diagnostics := CheckExpected(body, expected, sourceSpan)
	fnType := FunctionType(DeclParamCount(decl), expected)
	nextEnv := DefineSymbol(
		CheckEnv{
			First:       env.First,
			Second:      env.Second,
			Count:       env.Count,
			Diagnostics: diagnostics,
		},
		DeclName(decl),
		fnType,
	)
	return MakeCheckedDecl(decl, fnType, nextEnv)
}

func CheckDeclaration(env CheckEnv, decl Decl, sourceSpan Span) CheckedDecl {
	switch DeclTag(decl) {
	case 1:
		return CheckFunctionDecl(env, decl, sourceSpan)
	case 2:
		return CheckValueDecl(env, decl, sourceSpan)
	case 3:
		return CheckValueDecl(env, decl, sourceSpan)
	case 4:
		valueType := ProductType(DeclParamCount(decl))
		return MakeCheckedDecl(decl, valueType, DefineSymbol(env, DeclName(decl), valueType))
	default:
		return MakeCheckedDecl(decl, UnknownType(), env)
	}
}

func CheckSecondaryDeclaration(hasSecondary bool, env CheckEnv, decl Decl, sourceSpan Span) CheckedDecl {
	if hasSecondary {
		return CheckDeclaration(env, decl, sourceSpan)
	}
	return MakeCheckedDecl(decl, UnknownType(), env)
}

func CheckProgram(env CheckEnv, program Program, sourceSpan Span) CheckedProgram {
	entry := CheckDeclaration(env, program.EntryDecl, sourceSpan)
	hasSecondary := program.DeclarationCount > 1
	secondary := CheckSecondaryDeclaration(hasSecondary, entry.Env, program.SecondaryDecl, sourceSpan)
	return MakeCheckedProgram(program, entry, secondary, secondary.Env)
}

func SymbolScore(symbol CheckSymbol) int32 {
	return symbol.Name + TypeScore(symbol.ValueType)
}

func CheckEnvScore(env CheckEnv) int32 {
	return SymbolScore(env.First) +
		SymbolScore(env.Second) +
		env.Count +
		DiagnosticBagScore(env.Diagnostics)
}

func CheckedExprScore(value CheckedExpr) int32 {
	return ExprScore(value.Expr) +
		TypeScore(value.ValueType) +
		DiagnosticBagScore(value.Diagnostics)
}

func CheckedDeclScore(value CheckedDecl) int32 {
	return DeclScore(value.Decl) +
		TypeScore(value.ValueType) +
		CheckEnvScore(value.Env)
}

func CheckedProgramScore(value CheckedProgram) int32 {
	return ProgramScore(value.Program) +
		CheckedDeclScore(value.Entry) +
		CheckedDeclScore(value.Secondary) +
		CheckEnvScore(value.Env) +
		DiagnosticBagScore(value.Diagnostics)
}

func AbiScore(abi AbiClass) int32 {
	switch abi {
	case AbiScalar:
		return 11
	case AbiHandle:
		return 17
	case AbiFunction:
		return 23
	default:
		return 0
	}
}

func AbiTag(abi AbiClass) int32 {
	switch abi {
	case AbiScalar:
		return 1
	case AbiHandle:
		return 2
	case AbiFunction:
		return 3
	default:
		return 0
	}
}

func AbiForType(valueType Type) AbiClass {
	switch TypeTag(valueType) {
	case 1:
		return AbiScalar
	case 2:
		return AbiScalar
	case 3:
		return AbiFunction
	case 4:
		return AbiHandle
	default:
		return AbiVoid
	}
}

func LowerValue(abi AbiClass, seed int32) LoweredValue {
	switch abi {
	case AbiScalar:
		return LoweredValue{Kind: LoweredI32, Value: seed}
	case AbiHandle:
		return LoweredValue{Kind: LoweredHandle, Layout: TypeTag(ProductType(2)), Handle: seed}
	case AbiFunction:
		return LoweredValue{Kind: LoweredFunction, Index: seed}
	default:
		return LoweredValue{Kind: LoweredVoid}
	}
}

func LoweredValueScore(value LoweredValue) int32 {
	switch value.Kind {
	case LoweredI32:
		return value.Value
	case LoweredHandle:
		return value.Layout + value.Handle
	case LoweredFunction:
		return value.Index
	default:
		return 0
	}
}

func LoweredValueTag(value LoweredValue) int32 {
	switch value.Kind {
	case LoweredI32:
		return 1
	case LoweredHandle:
		return 2
	case LoweredFunction:
		return 3
	default:
		return 0
	}
}

func LoweredValuePrimary(value LoweredValue) int32 {
	switch value.Kind {
	case LoweredI32:
		return value.Value
	case LoweredHandle:
		return value.Layout
	case LoweredFunction:
		return value.Index
	default:
		return 0
	}
}

func LoweredValueSecondary(value LoweredValue) int32 {
	switch value.Kind {
	case LoweredHandle:
		return value.Handle
	default:
		return 0
	}
}

func NeedsLoweringError(abi AbiClass, decl Decl) bool {
	if abi == AbiVoid {
		return DeclTag(decl) != 5
	}
	return false
}

func LowerDiagnostics(checked CheckedDecl, abi AbiClass, sourceSpan Span) DiagnosticBag {
	if NeedsLoweringError(abi, checked.Decl) {
		return PushDiagnostic(
			checked.Env.Diagnostics,
			MakeDiagnostic(
				CodeTypeMismatch,
				SeverityError,
				sourceSpan,
				TypeTag(checked.ValueType),
				0,
			),
		)
	}
	return checked.Env.Diagnostics
}

func LowerDeclaration(checked CheckedDecl, sourceSpan Span) LoweredDecl {
	abi := AbiForType(checked.ValueType)
	return LoweredDecl{
		Name:        DeclName(checked.Decl),
		ABI:         abi,
		Value:       LowerValue(abi, DeclScore(checked.Decl)),
		Diagnostics: LowerDiagnostics(checked, abi, sourceSpan),
	}
}

func MakeLoweredProgram(program Program, entry LoweredDecl, secondary LoweredDecl) LoweredProgram {
	diagnostics := entry.Diagnostics
	if program.DeclarationCount > 1 {
		diagnostics = MergeDiagnosticBags(entry.Diagnostics, secondary.Diagnostics)
	}
	return LoweredProgram{
		Program:     program,
		Entry:       entry,
		Secondary:   secondary,
		Diagnostics: diagnostics,
	}
}

func LowerProgram(checked CheckedProgram, sourceSpan Span) LoweredProgram {
	entry := LowerDeclaration(checked.Entry, sourceSpan)
	secondary := LowerDeclaration(checked.Secondary, sourceSpan)
	return MakeLoweredProgram(checked.Program, entry, secondary)
}

func LoweredDeclScore(value LoweredDecl) int32 {
	return value.Name +
		AbiScore(value.ABI) +
		LoweredValueScore(value.Value) +
		DiagnosticBagScore(value.Diagnostics)
}

func LoweredProgramScore(value LoweredProgram) int32 {
	return ProgramScore(value.Program) +
		LoweredDeclScore(value.Entry) +
		LoweredDeclScore(value.Secondary) +
		DiagnosticBagScore(value.Diagnostics)
}

func WasmValTypeScore(value WasmValType) int32 {
	switch value {
	case WasmI32:
		return 1
	case WasmI64:
		return 2
	case WasmExternRef:
		return 3
	default:
		return 0
	}
}

func WasmInstrScore(value WasmInstr) int32 {
	switch value.Kind {
	case InstrConst:
		return value.Value + 11
	case InstrLocalGet:
		return value.Index + 17
	case InstrCall:
		return value.Index + 23
	case InstrReturn:
		return 29
	case InstrDrop:
		return 31
	case InstrTrap:
		return value.Code + 37
	default:
		return 0
	}
}

func WasmByteOf(value int32) WasmByte {
	return WasmByte{Value: value % 256}
}

func WasmByteScore(value WasmByte) int32 {
	return value.Value
}

func WasmBytes4(first int32, second int32, third int32, fourth int32, length int32) WasmBytes {
	firstByte := WasmByteOf(first)
	secondByte := WasmByteOf(second)
	thirdByte := WasmByteOf(third)
	fourthByte := WasmByteOf(fourth)
	return WasmBytes{
		First:  firstByte,
		Second: secondByte,
		Third:  thirdByte,
		Fourth: fourthByte,
		Length: length,
		Checksum: WasmByteScore(firstByte) +
			WasmByteScore(secondByte)*3 +
			WasmByteScore(thirdByte)*5 +
			WasmByteScore(fourthByte)*7 +
			length*11,
	}
}

func WasmBytesScore(value WasmBytes) int32 {
	return WasmByteScore(value.First) +
		WasmByteScore(value.Second) +
		WasmByteScore(value.Third) +
		WasmByteScore(value.Fourth) +
		value.Length +
		value.Checksum
}

func WasmSectionKindScore(value WasmSectionKind) int32 {
	switch value {
	case SectionType:
		return 1
	case SectionFunction:
		return 3
	case SectionExport:
		return 7
	case SectionCode:
		return 10
	default:
		return 0
	}
}

func WasmValTypeByte(value WasmValType) int32 {
	switch value {
	case WasmI32:
		return 127
	case WasmI64:
		return 126
	case WasmExternRef:
		return 111
	default:
		return 64
	}
}

func WasmResultArity(value WasmValType) int32 {
	if value == WasmNoVal {
		return 0
	}
	return 1
}

func WasmInstrOpcode(value WasmInstr) int32 {
	switch value.Kind {
	case InstrConst:
		return 65
	case InstrLocalGet:
		return 32
	case InstrCall:
		return 16
	case InstrReturn:
		return 15
	case InstrDrop:
		return 26
	case InstrTrap:
		return 0
	default:
		return 1
	}
}

func WasmInstrImmediate(value WasmInstr) int32 {
	switch value.Kind {
	case InstrConst:
		return value.Value
	case InstrLocalGet:
		return value.Index
	case InstrCall:
		return value.Index
	case InstrTrap:
		return value.Code
	default:
		return 0
	}
}

func WasmValTypeForABI(abi AbiClass) WasmValType {
	switch AbiTag(abi) {
	case 1:
		return WasmI32
	case 2:
		return WasmExternRef
	case 3:
		return WasmI32
	default:
		return WasmNoVal
	}
}

func WasmInstrFromLoweredValue(value LoweredValue) WasmInstr {
	switch LoweredValueTag(value) {
	case 1:
		return WasmInstr{Kind: InstrConst, Value: LoweredValuePrimary(value)}
	case 2:
		return WasmInstr{
			Kind: InstrConst,
			Value: LoweredValuePrimary(value) +
				LoweredValueSecondary(value),
		}
	case 3:
		return WasmInstr{Kind: InstrCall, Index: LoweredValuePrimary(value)}
	default:
		return WasmInstr{Kind: InstrDrop}
	}
}

func WasmTerminatorForResult(result WasmValType) WasmInstr {
	if result == WasmNoVal {
		return WasmInstr{Kind: InstrDrop}
	}
	return WasmInstr{Kind: InstrReturn}
}

func WasmFuncScore(value WasmFunc) int32 {
	return value.Name +
		value.ParamCount +
		WasmValTypeScore(value.Result) +
		WasmInstrScore(value.First) +
		WasmInstrScore(value.Second) +
		WasmInstrScore(value.Third) +
		DiagnosticBagScore(value.Diagnostics)
}

func ActiveSecondWasmFuncScore(value WasmModule) int32 {
	if value.FunctionCount > 1 {
		return WasmFuncScore(value.Second)
	}
	return 0
}

func WasmModuleScore(value WasmModule) int32 {
	return WasmFuncScore(value.First) +
		ActiveSecondWasmFuncScore(value) +
		value.FunctionCount +
		value.ExportCount +
		DiagnosticBagScore(value.Diagnostics)
}

func WasmSectionScore(value WasmSection) int32 {
	return WasmSectionKindScore(value.Kind) +
		WasmBytesScore(value.Payload) +
		value.Size +
		DiagnosticBagScore(value.Diagnostics)
}

func WasmBinaryScore(value WasmBinary) int32 {
	return value.Magic +
		value.Version +
		WasmSectionScore(value.TypeSection) +
		WasmSectionScore(value.FunctionSection) +
		WasmSectionScore(value.ExportSection) +
		WasmSectionScore(value.CodeSection) +
		DiagnosticBagScore(value.Diagnostics)
}

func EmitWasmFunction(lowered LoweredDecl, sourceSpan Span) WasmFunc {
	_ = sourceSpan
	result := WasmValTypeForABI(lowered.ABI)
	return WasmFunc{
		Name:        lowered.Name,
		ParamCount:  0,
		Result:      result,
		First:       WasmInstrFromLoweredValue(lowered.Value),
		Second:      WasmTerminatorForResult(result),
		Third:       WasmInstr{Kind: InstrNop},
		Diagnostics: lowered.Diagnostics,
	}
}

func EmitWasmModule(lowered LoweredDecl, sourceSpan Span) WasmModule {
	first := EmitWasmFunction(lowered, sourceSpan)
	return WasmModule{
		First:         first,
		Second:        EmptyWasmFunction(),
		FunctionCount: 1,
		ExportCount:   1,
		Diagnostics:   lowered.Diagnostics,
	}
}

func EmptyWasmFunction() WasmFunc {
	return WasmFunc{
		Result:      WasmNoVal,
		First:       WasmInstr{Kind: InstrNop},
		Second:      WasmInstr{Kind: InstrDrop},
		Third:       WasmInstr{Kind: InstrNop},
		Diagnostics: EmptyDiagnosticBag(),
	}
}

func ProgramFunctionCount(program Program) int32 {
	if program.DeclarationCount > 1 {
		return 2
	}
	return 1
}

func ProgramWasmDiagnostics(program Program, first WasmFunc, second WasmFunc) DiagnosticBag {
	if program.DeclarationCount > 1 {
		return MergeDiagnosticBags(first.Diagnostics, second.Diagnostics)
	}
	return first.Diagnostics
}

func EmitWasmProgram(lowered LoweredProgram, sourceSpan Span) WasmModule {
	first := EmitWasmFunction(lowered.Entry, sourceSpan)
	second := EmitWasmFunction(lowered.Secondary, sourceSpan)
	return WasmModule{
		First:         first,
		Second:        second,
		FunctionCount: ProgramFunctionCount(lowered.Program),
		ExportCount:   ProgramFunctionCount(lowered.Program),
		Diagnostics:   ProgramWasmDiagnostics(lowered.Program, first, second),
	}
}

func MakeWasmSection(kind WasmSectionKind, payload WasmBytes, diagnostics DiagnosticBag) WasmSection {
	return WasmSection{
		Kind:        kind,
		Payload:     payload,
		Size:        payload.Length + 2,
		Diagnostics: diagnostics,
	}
}

func EncodeWasmTypeSection(function WasmFunc) WasmSection {
	return MakeWasmSection(
		SectionType,
		WasmBytes4(
			96,
			function.ParamCount,
			WasmResultArity(function.Result),
			WasmValTypeByte(function.Result),
			4,
		),
		function.Diagnostics,
	)
}

func EncodeWasmFunctionSection(value WasmModule) WasmSection {
	return MakeWasmSection(
		SectionFunction,
		WasmBytes4(
			value.FunctionCount,
			0,
			0,
			0,
			2,
		),
		value.Diagnostics,
	)
}

func EncodeWasmExportSection(value WasmModule) WasmSection {
	return MakeWasmSection(
		SectionExport,
		WasmBytes4(
			value.ExportCount,
			value.First.Name,
			0,
			0,
			4,
		),
		value.Diagnostics,
	)
}

func WasmBodySize(function WasmFunc) int32 {
	return 1 +
		WasmInstrScore(function.First)%7 +
		WasmInstrScore(function.Second)%7 +
		WasmInstrScore(function.Third)%7
}

func SecondWasmBodySize(value WasmModule) int32 {
	if value.FunctionCount > 1 {
		return WasmBodySize(value.Second)
	}
	return 0
}

func SecondWasmOpcode(value WasmModule) int32 {
	if value.FunctionCount > 1 {
		return WasmInstrOpcode(value.Second.First)
	}
	return 0
}

func EncodeWasmCodeSection(value WasmModule) WasmSection {
	function := value.First
	return MakeWasmSection(
		SectionCode,
		WasmBytes4(
			value.FunctionCount,
			WasmBodySize(function)+SecondWasmBodySize(value),
			WasmInstrOpcode(function.First),
			WasmInstrOpcode(function.Second)+
				WasmInstrImmediate(function.First)+
				SecondWasmOpcode(value),
			4,
		),
		value.Diagnostics,
	)
}

func EncodeWasmBinary(value WasmModule) WasmBinary {
	return WasmBinary{
		Magic:           1836278016,
		Version:         1,
		TypeSection:     EncodeWasmTypeSection(value.First),
		FunctionSection: EncodeWasmFunctionSection(value),
		ExportSection:   EncodeWasmExportSection(value),
		CodeSection:     EncodeWasmCodeSection(value),
		Diagnostics:     value.Diagnostics,
	}
}

func WasmEntry(seed int32) int32 {
	decl := FnDeclOf(seed, 1, NamedType(seed+1), CallExprOf(seed+2, seed+3))
	sourceSpan := MakeSpan(seed, seed+10, 1, 1)
	checked := CheckDeclaration(SeedCheckEnv(seed), decl, sourceSpan)
	lowered := LowerDeclaration(checked, sourceSpan)
	emitted := EmitWasmModule(lowered, sourceSpan)
	program := ProgramOf(seed, 1, decl, EmptyDecl(), sourceSpan)
	checkedProgram := CheckProgram(SeedCheckEnv(seed), program, sourceSpan)
	loweredProgram := LowerProgram(checkedProgram, sourceSpan)
	emittedProgram := EmitWasmProgram(loweredProgram, sourceSpan)
	return WasmModuleScore(emitted) +
		WasmBinaryScore(EncodeWasmBinary(emitted)) +
		WasmModuleScore(emittedProgram) +
		WasmBinaryScore(EncodeWasmBinary(emittedProgram))
}

func PhaseScore(phase CompilePhase) int32 {
	switch phase {
	case PhaseSource:
		return 1
	case PhaseParsed:
		return 2
	case PhaseChecked:
		return 3
	case PhaseLowered:
		return 4
	default:
		return 0
	}
}

func FallbackDecl(first Token, seed int32) Decl {
	return DeclarationFromToken(first.Kind, seed)
}

func MakeModuleArtifact(
	moduleID int32,
	source SourceText,
	decl Decl,
	checked CheckedDecl,
	lowered LoweredDecl,
	diagnostics DiagnosticBag,
	phase CompilePhase,
) ModuleArtifact {
	return ModuleArtifact{
		ModuleID:    moduleID,
		Source:      source,
		Decl:        decl,
		Checked:     checked,
		Lowered:     lowered,
		Diagnostics: diagnostics,
		Phase:       phase,
	}
}

func PlaceholderArtifact() ModuleArtifact {
	sourceSpan := MakeSpan(0, 0, 0, 0)
	text := SourceFromSeed(0)
	decl := Decl{Kind: SourceImportDecl, Name: 0, Annotation: MissingTypeAnnotationOf()}
	checked := CheckDeclaration(EmptyCheckEnv(), decl, sourceSpan)
	lowered := LowerDeclaration(checked, sourceSpan)
	return MakeModuleArtifact(
		0,
		text,
		decl,
		checked,
		lowered,
		EmptyDiagnosticBag(),
		PhaseSource,
	)
}

func EmptyArtifactTable() ArtifactTable {
	return ArtifactTable{
		First:       PlaceholderArtifact(),
		Second:      PlaceholderArtifact(),
		Count:       0,
		Diagnostics: EmptyDiagnosticBag(),
	}
}

func CompileSource(moduleID int32, text SourceText, incoming DiagnosticBag, seed int32) ModuleArtifact {
	tokens := StreamFromSource(text)
	first := TokenAt(tokens, 0)
	parsed := ParseDeclarationStream(State(0, tokens.Length), tokens, seed)
	decl := ParsedDeclOrFallback(parsed, FallbackDecl(first, seed))
	checked := CheckDeclaration(SeedCheckEnv(seed), decl, tokens.SourceSpan)
	lowered := LowerDeclaration(checked, tokens.SourceSpan)
	return MakeModuleArtifact(
		moduleID,
		text,
		decl,
		checked,
		lowered,
		MergeDiagnosticBags(incoming, lowered.Diagnostics),
		PhaseLowered,
	)
}

func InsertArtifact(table ArtifactTable, value ModuleArtifact) ArtifactTable {
	diagnostics := MergeDiagnosticBags(table.Diagnostics, value.Diagnostics)
	switch table.Count {
	case 0:
		return ArtifactTable{
			First:       value,
			Second:      table.Second,
			Count:       1,
			Diagnostics: diagnostics,
		}
	case 1:
		return ArtifactTable{
			First:       table.First,
			Second:      value,
			Count:       2,
			Diagnostics: diagnostics,
		}
	default:
		return ArtifactTable{
			First:       table.First,
			Second:      table.Second,
			Count:       table.Count + 1,
			Diagnostics: diagnostics,
		}
	}
}

func ParsedDeclOrFallback(parsed ParseResult, fallback Decl) Decl {
	if parsed.Ok {
		return parsed.Value.Decl
	}
	return fallback
}

func CompileRequest(current ResolveState, request ResolveRequest, seed int32) CompileStep {
	resolved := ResolveModule(current, request)
	text := StepSource(resolved)
	artifact := CompileSource(
		SourceModuleSeed(text),
		text,
		resolved.State.Diagnostics,
		seed,
	)
	return CompileStep{Resolve: resolved, Artifact: artifact}
}

func CompileGraph(seed int32) ArtifactTable {
	graph := ModuleGraphFromSeed(seed)
	sourceSpan := MakeSpan(seed, seed+1, 1, 1)
	root := CompileRequest(
		NewResolveState(graph),
		MakeResolveRequest(RootID(graph), RootID(graph), sourceSpan),
		seed,
	)
	dependency := CompileRequest(
		root.Resolve.State,
		MakeResolveRequest(RootID(graph), RootImportID(graph), sourceSpan),
		seed+1,
	)
	return InsertArtifact(InsertArtifact(EmptyArtifactTable(), root.Artifact), dependency.Artifact)
}

func ModuleArtifactScore(value ModuleArtifact) int32 {
	return value.ModuleID +
		SourceScore(value.Source) +
		DeclScore(value.Decl) +
		CheckedDeclScore(value.Checked) +
		LoweredDeclScore(value.Lowered) +
		DiagnosticBagScore(value.Diagnostics) +
		PhaseScore(value.Phase)
}

func ArtifactTableScore(table ArtifactTable) int32 {
	return ModuleArtifactScore(table.First) +
		ModuleArtifactScore(table.Second) +
		table.Count +
		DiagnosticBagScore(table.Diagnostics)
}

func SymbolNodeKindScore(kind SymbolNodeKind) int32 {
	switch kind {
	case NodeFunction:
		return 1
	case NodeValue:
		return 2
	case NodeType:
		return 3
	case NodeImport:
		return 4
	default:
		return 0
	}
}

func DeclEdgeKindScore(kind DeclEdgeKind) int32 {
	switch kind {
	case ValueDependency:
		return 11
	case TypeDependency:
		return 13
	case ImportDependency:
		return 17
	default:
		return 0
	}
}

func ResolutionStateScore(state ResolutionState) int32 {
	switch state.Kind {
	case Resolved:
		return 1
	case Failed:
		return 2 + DiagnosticBagScore(state.Diagnostics)
	default:
		return 0
	}
}

func ResolutionStateDiagnostics(state ResolutionState) DiagnosticBag {
	if state.Kind == Failed {
		return state.Diagnostics
	}
	return EmptyDiagnosticBag()
}

func SymbolNodeKindFromDecl(decl Decl) SymbolNodeKind {
	switch DeclTag(decl) {
	case 1:
		return NodeFunction
	case 2:
		return NodeValue
	case 3:
		return NodeValue
	case 4:
		return NodeType
	default:
		return NodeImport
	}
}

func DeclDeclaredType(decl Decl) Type {
	switch DeclTag(decl) {
	case 1:
		return FunctionType(DeclParamCount(decl), TypeFromSymbol(DeclTypeName(decl)))
	case 2:
		return TypeFromSymbol(DeclTypeName(decl))
	case 3:
		return TypeFromSymbol(DeclTypeName(decl))
	case 4:
		return ProductType(DeclParamCount(decl))
	default:
		return UnknownType()
	}
}

func MakeDeclNode(nodeID int32, decl Decl, sourceSpan Span) DeclNode {
	return DeclNode{
		NodeID:       nodeID,
		Name:         DeclName(decl),
		Decl:         decl,
		Kind:         SymbolNodeKindFromDecl(decl),
		DeclaredType: DeclDeclaredType(decl),
		InferredType: UnknownType(),
		State:        ResolutionState{Kind: Pending},
		Span:         sourceSpan,
	}
}

func MakeDeclEdge(fromID int32, toID int32, kind DeclEdgeKind) DeclEdge {
	return DeclEdge{
		FromID: fromID,
		ToID:   toID,
		Kind:   kind,
		Weight: fromID + toID + DeclEdgeKindScore(kind),
	}
}

func MakeSymbolGraph(
	first DeclNode,
	second DeclNode,
	third DeclNode,
	fourth DeclNode,
	firstEdge DeclEdge,
	secondEdge DeclEdge,
	thirdEdge DeclEdge,
) SymbolGraph {
	return SymbolGraph{
		First:       first,
		Second:      second,
		Third:       third,
		Fourth:      fourth,
		FirstEdge:   firstEdge,
		SecondEdge:  secondEdge,
		ThirdEdge:   thirdEdge,
		NodeCount:   4,
		EdgeCount:   3,
		Diagnostics: EmptyDiagnosticBag(),
	}
}

func SymbolGraphFromSeed(seed int32) SymbolGraph {
	typeDecl := Decl{Kind: TypeDecl, Name: seed, ParamCount: 2}
	valueDecl := LetDeclOf(seed+1, NamedType(seed), IntExpr(seed+10))
	constDecl := Decl{
		Kind:       ConstDecl,
		Name:       seed + 2,
		Annotation: NamedType(seed + 1),
		Value:      VarExprOf(seed + 1),
	}
	fnDecl := FnDeclOf(seed+3, 1, NamedType(seed+2), VarExprOf(seed+2))
	return MakeSymbolGraph(
		MakeDeclNode(1, typeDecl, MakeSpan(seed, seed+2, 1, 1)),
		MakeDeclNode(2, valueDecl, MakeSpan(seed+2, seed+4, 2, 1)),
		MakeDeclNode(3, constDecl, MakeSpan(seed+4, seed+6, 3, 1)),
		MakeDeclNode(4, fnDecl, MakeSpan(seed+6, seed+8, 4, 1)),
		MakeDeclEdge(2, 1, TypeDependency),
		MakeDeclEdge(3, 2, ValueDependency),
		MakeDeclEdge(4, 3, ValueDependency),
	)
}

func HasBackEdge(edge DeclEdge) bool {
	return edge.ToID >= edge.FromID
}

func CycleCount(graph SymbolGraph) int32 {
	count := int32(0)
	if HasBackEdge(graph.FirstEdge) {
		count += 1
	}
	if HasBackEdge(graph.SecondEdge) {
		count += 1
	}
	if HasBackEdge(graph.ThirdEdge) {
		count += 1
	}
	return count
}

func ResolutionOrderFor(graph SymbolGraph) ResolutionOrder {
	return ResolutionOrder{
		FirstID:    graph.First.NodeID,
		SecondID:   graph.Second.NodeID,
		ThirdID:    graph.Third.NodeID,
		FourthID:   graph.Fourth.NodeID,
		Count:      graph.NodeCount,
		CycleCount: CycleCount(graph),
	}
}

func BindDeclNode(env CheckEnv, node DeclNode) CheckEnv {
	return DefineSymbol(env, node.Name, node.DeclaredType)
}

func ResolveDeclNode(env CheckEnv, node DeclNode) DeclNode {
	checked := CheckDeclaration(env, node.Decl, node.Span)
	nextState := ResolutionState{Kind: Resolved}
	if checked.Env.Diagnostics.Count != 0 {
		nextState = ResolutionState{Kind: Failed, Diagnostics: checked.Env.Diagnostics}
	}
	return DeclNode{
		NodeID:       node.NodeID,
		Name:         node.Name,
		Decl:         node.Decl,
		Kind:         node.Kind,
		DeclaredType: node.DeclaredType,
		InferredType: checked.ValueType,
		State:        nextState,
		Span:         node.Span,
	}
}

func ResolveSymbolGraph(graph SymbolGraph) SymbolGraph {
	env0 := EmptyCheckEnv()
	first := ResolveDeclNode(env0, graph.First)
	env1 := BindDeclNode(env0, first)
	second := ResolveDeclNode(env1, graph.Second)
	env2 := BindDeclNode(env1, second)
	third := ResolveDeclNode(env2, graph.Third)
	env3 := BindDeclNode(env2, third)
	fourth := ResolveDeclNode(env3, graph.Fourth)
	diagnostics := MergeDiagnosticBags(
		MergeDiagnosticBags(
			ResolutionStateDiagnostics(first.State),
			ResolutionStateDiagnostics(second.State),
		),
		MergeDiagnosticBags(
			ResolutionStateDiagnostics(third.State),
			ResolutionStateDiagnostics(fourth.State),
		),
	)
	return SymbolGraph{
		First:       first,
		Second:      second,
		Third:       third,
		Fourth:      fourth,
		FirstEdge:   graph.FirstEdge,
		SecondEdge:  graph.SecondEdge,
		ThirdEdge:   graph.ThirdEdge,
		NodeCount:   graph.NodeCount,
		EdgeCount:   graph.EdgeCount,
		Diagnostics: diagnostics,
	}
}

func DeclNodeScore(node DeclNode) int32 {
	return node.NodeID +
		node.Name +
		DeclScore(node.Decl) +
		SymbolNodeKindScore(node.Kind) +
		TypeScore(node.DeclaredType) +
		TypeScore(node.InferredType) +
		ResolutionStateScore(node.State) +
		SpanWidth(node.Span)
}

func DeclEdgeScore(edge DeclEdge) int32 {
	return edge.FromID +
		edge.ToID +
		DeclEdgeKindScore(edge.Kind) +
		edge.Weight
}

func ResolutionOrderScore(order ResolutionOrder) int32 {
	return order.FirstID +
		order.SecondID +
		order.ThirdID +
		order.FourthID +
		order.Count +
		order.CycleCount
}

func SymbolGraphScore(graph SymbolGraph) int32 {
	return DeclNodeScore(graph.First) +
		DeclNodeScore(graph.Second) +
		DeclNodeScore(graph.Third) +
		DeclNodeScore(graph.Fourth) +
		DeclEdgeScore(graph.FirstEdge) +
		DeclEdgeScore(graph.SecondEdge) +
		DeclEdgeScore(graph.ThirdEdge) +
		graph.NodeCount +
		graph.EdgeCount +
		DiagnosticBagScore(graph.Diagnostics) +
		ResolutionOrderScore(ResolutionOrderFor(graph))
}

func DeclGraphEntry(seed int32) int32 {
	return SymbolGraphScore(ResolveSymbolGraph(SymbolGraphFromSeed(seed)))
}

func RoleScore(role ModuleRole) int32 {
	switch role {
	case RootModule:
		return 101
	case FeatureModule:
		return 103
	case UtilityModule:
		return 107
	case SharedModule:
		return 109
	default:
		return 0
	}
}

func ReasonScore(reason InvalidationReason) int32 {
	switch reason.Kind {
	case SourceChanged:
		return reason.ModuleID + 11
	case DependencyChanged:
		return reason.ModuleID + 17
	default:
		return 0
	}
}

func StateScore(state CacheEntryState) int32 {
	switch state.Kind {
	case CacheMissing:
		return 1
	case CacheFresh:
		return 2
	case CacheStale:
		return 3 + ReasonScore(state.Reason)
	default:
		return 0
	}
}

func IsInvalidated(reason InvalidationReason) bool {
	return reason.Kind != NoInvalidation
}

func StateFromReason(reason InvalidationReason) CacheEntryState {
	if !IsInvalidated(reason) {
		return CacheEntryState{Kind: CacheFresh}
	}
	return CacheEntryState{Kind: CacheStale, Reason: reason}
}

func SourceRevision(role ModuleRole, text SourceText) int32 {
	return RoleScore(role)*997 + SourceScore(text)
}

func MakeModuleNode(
	role ModuleRole,
	record ModuleRecord,
	secondImportID int32,
	dependencyRevision int32,
) ModuleNode {
	return ModuleNode{
		Role:               role,
		Record:             record,
		SecondImportID:     secondImportID,
		SourceRevision:     SourceRevision(role, record.Source),
		DependencyRevision: dependencyRevision,
	}
}

func IncrementalClusterFromSeed(seed int32) ModuleCluster {
	shared := MakeModuleNode(
		SharedModule,
		MakeModuleRecord(seed+3, 0, SourceFromSeed(seed+3)),
		0,
		0,
	)
	feature := MakeModuleNode(
		FeatureModule,
		MakeModuleRecord(seed+1, shared.Record.ModuleID, SourceFromSeed(seed+1)),
		0,
		shared.SourceRevision,
	)
	utility := MakeModuleNode(
		UtilityModule,
		MakeModuleRecord(seed+2, shared.Record.ModuleID, SourceFromSeed(seed+2)),
		0,
		shared.SourceRevision,
	)
	root := MakeModuleNode(
		RootModule,
		MakeModuleRecord(seed, feature.Record.ModuleID, SourceFromSeed(seed)),
		utility.Record.ModuleID,
		feature.SourceRevision+utility.SourceRevision,
	)
	return ModuleCluster{Root: root, Feature: feature, Utility: utility, Shared: shared, Count: 4}
}

func ChangeFromSeed(seed int32) SourceChange {
	switch seed % 5 {
	case 0:
		return SourceChange{Kind: NoChange}
	case 1:
		return SourceChange{Kind: EditModule, Role: RootModule, Delta: seed + 31}
	case 2:
		return SourceChange{Kind: EditModule, Role: FeatureModule, Delta: seed + 37}
	case 3:
		return SourceChange{Kind: EditModule, Role: UtilityModule, Delta: seed + 41}
	default:
		return SourceChange{Kind: EditModule, Role: SharedModule, Delta: seed + 43}
	}
}

func ChangedSource(node ModuleNode, change SourceChange) SourceText {
	if change.Kind == EditModule {
		if change.Role == node.Role {
			return SourceFromSeed(node.Record.ModuleID + change.Delta)
		}
	}
	return node.Record.Source
}

func ApplyChange(cluster ModuleCluster, change SourceChange) ModuleCluster {
	shared := MakeModuleNode(
		SharedModule,
		MakeModuleRecord(
			cluster.Shared.Record.ModuleID,
			0,
			ChangedSource(cluster.Shared, change),
		),
		0,
		0,
	)
	feature := MakeModuleNode(
		FeatureModule,
		MakeModuleRecord(
			cluster.Feature.Record.ModuleID,
			shared.Record.ModuleID,
			ChangedSource(cluster.Feature, change),
		),
		0,
		shared.SourceRevision,
	)
	utility := MakeModuleNode(
		UtilityModule,
		MakeModuleRecord(
			cluster.Utility.Record.ModuleID,
			shared.Record.ModuleID,
			ChangedSource(cluster.Utility, change),
		),
		0,
		shared.SourceRevision,
	)
	root := MakeModuleNode(
		RootModule,
		MakeModuleRecord(
			cluster.Root.Record.ModuleID,
			feature.Record.ModuleID,
			ChangedSource(cluster.Root, change),
		),
		utility.Record.ModuleID,
		feature.SourceRevision+utility.SourceRevision,
	)
	return ModuleCluster{
		Root:    root,
		Feature: feature,
		Utility: utility,
		Shared:  shared,
		Count:   cluster.Count,
	}
}

func CompileNode(node ModuleNode, seed int32) ModuleArtifact {
	return CompileSource(
		node.Record.ModuleID,
		node.Record.Source,
		EmptyDiagnosticBag(),
		seed,
	)
}

func MakeCacheEntry(node ModuleNode, state CacheEntryState, seed int32) CacheEntry {
	compiled := CompileNode(node, seed)
	return CacheEntry{
		ModuleID:           node.Record.ModuleID,
		SourceRevision:     node.SourceRevision,
		DependencyRevision: node.DependencyRevision,
		ArtifactRevision: ModuleArtifactScore(compiled) +
			node.SourceRevision +
			node.DependencyRevision,
		Compiled: compiled,
		State:    state,
	}
}

func WithCacheState(entry CacheEntry, state CacheEntryState) CacheEntry {
	return CacheEntry{
		ModuleID:           entry.ModuleID,
		SourceRevision:     entry.SourceRevision,
		DependencyRevision: entry.DependencyRevision,
		ArtifactRevision:   entry.ArtifactRevision,
		Compiled:           entry.Compiled,
		State:              state,
	}
}

func InitialCache(cluster ModuleCluster, seed int32) ArtifactCache {
	return ArtifactCache{
		Root:              MakeCacheEntry(cluster.Root, CacheEntryState{Kind: CacheFresh}, seed),
		Feature:           MakeCacheEntry(cluster.Feature, CacheEntryState{Kind: CacheFresh}, seed+1),
		Utility:           MakeCacheEntry(cluster.Utility, CacheEntryState{Kind: CacheFresh}, seed+2),
		Shared:            MakeCacheEntry(cluster.Shared, CacheEntryState{Kind: CacheFresh}, seed+3),
		HitCount:          0,
		MissCount:         4,
		InvalidationCount: 0,
	}
}

func InvalidationReasonFor(entry CacheEntry, node ModuleNode) InvalidationReason {
	if entry.SourceRevision != node.SourceRevision {
		return InvalidationReason{Kind: SourceChanged, ModuleID: node.Record.ModuleID}
	}
	if entry.DependencyRevision != node.DependencyRevision {
		return InvalidationReason{Kind: DependencyChanged, ModuleID: node.Record.ModuleID}
	}
	return InvalidationReason{Kind: NoInvalidation}
}

func RefreshEntry(before CacheEntry, node ModuleNode, seed int32) RefreshStep {
	reason := InvalidationReasonFor(before, node)
	marked := WithCacheState(before, StateFromReason(reason))
	after := WithCacheState(before, CacheEntryState{Kind: CacheFresh})
	if IsInvalidated(reason) {
		after = MakeCacheEntry(node, CacheEntryState{Kind: CacheFresh}, seed)
	}
	return RefreshStep{Before: marked, After: after, Reason: reason}
}

func InvalidationCountFor(step RefreshStep) int32 {
	if IsInvalidated(step.Reason) {
		return 1
	}
	return 0
}

func RefreshedCache(
	root RefreshStep,
	feature RefreshStep,
	utility RefreshStep,
	shared RefreshStep,
) ArtifactCache {
	invalidations := InvalidationCountFor(root) +
		InvalidationCountFor(feature) +
		InvalidationCountFor(utility) +
		InvalidationCountFor(shared)
	return ArtifactCache{
		Root:              root.After,
		Feature:           feature.After,
		Utility:           utility.After,
		Shared:            shared.After,
		HitCount:          4 - invalidations,
		MissCount:         0,
		InvalidationCount: invalidations,
	}
}

func MakeRefreshPlan(before ArtifactCache, next ModuleCluster, seed int32) RefreshPlan {
	shared := RefreshEntry(before.Shared, next.Shared, seed+3)
	feature := RefreshEntry(before.Feature, next.Feature, seed+1)
	utility := RefreshEntry(before.Utility, next.Utility, seed+2)
	root := RefreshEntry(before.Root, next.Root, seed)
	return RefreshPlan{
		Root:        root,
		Feature:     feature,
		Utility:     utility,
		Shared:      shared,
		Cache:       RefreshedCache(root, feature, utility, shared),
		Diagnostics: EmptyDiagnosticBag(),
	}
}

func ModuleNodeScore(node ModuleNode) int32 {
	return RoleScore(node.Role) +
		ModuleScore(node.Record) +
		node.SecondImportID +
		node.SourceRevision +
		node.DependencyRevision
}

func ModuleClusterScore(cluster ModuleCluster) int32 {
	return ModuleNodeScore(cluster.Root) +
		ModuleNodeScore(cluster.Feature) +
		ModuleNodeScore(cluster.Utility) +
		ModuleNodeScore(cluster.Shared) +
		cluster.Count
}

func CacheEntryScore(entry CacheEntry) int32 {
	return entry.ModuleID +
		entry.SourceRevision +
		entry.DependencyRevision +
		entry.ArtifactRevision +
		ModuleArtifactScore(entry.Compiled) +
		StateScore(entry.State)
}

func ArtifactCacheScore(cache ArtifactCache) int32 {
	return CacheEntryScore(cache.Root) +
		CacheEntryScore(cache.Feature) +
		CacheEntryScore(cache.Utility) +
		CacheEntryScore(cache.Shared) +
		cache.HitCount +
		cache.MissCount +
		cache.InvalidationCount
}

func RefreshStepScore(step RefreshStep) int32 {
	return CacheEntryScore(step.Before) +
		CacheEntryScore(step.After) +
		ReasonScore(step.Reason)
}

func RefreshPlanScore(plan RefreshPlan) int32 {
	return RefreshStepScore(plan.Root) +
		RefreshStepScore(plan.Feature) +
		RefreshStepScore(plan.Utility) +
		RefreshStepScore(plan.Shared) +
		ArtifactCacheScore(plan.Cache) +
		DiagnosticBagScore(plan.Diagnostics)
}

func IncrementalEntry(seed int32) int32 {
	before := IncrementalClusterFromSeed(seed)
	after := ApplyChange(before, ChangeFromSeed(seed))
	cache := InitialCache(before, seed)
	return ModuleClusterScore(after) + RefreshPlanScore(MakeRefreshPlan(cache, after, seed+10))
}

func Entry(seed int32) int32 {
	graph := ModuleGraphFromSeed(seed)
	sourceSpan := MakeSpan(seed, seed+1, 1, 1)
	resolveStep := ResolveModule(
		NewResolveState(graph),
		MakeResolveRequest(RootID(graph), RootImportID(graph), sourceSpan),
	)
	moduleSource := StepSource(resolveStep)
	source := StreamFromSource(moduleSource)
	first := TokenAt(source, 0)
	parsed := ParseDeclarationStream(State(0, source.Length), source, seed)
	expr := ParseExpression(State(2, source.Length), source, seed+1)
	fallback := DeclarationFromToken(first.Kind, seed)
	decl := fallback
	if parsed.Ok {
		decl = parsed.Value.Decl
	}
	checked := CheckDeclaration(SeedCheckEnv(seed), decl, source.SourceSpan)
	lowered := LowerDeclaration(checked, source.SourceSpan)
	emitted := EmitWasmModule(lowered, source.SourceSpan)
	encoded := EncodeWasmBinary(emitted)
	lexed := LexSourceAt(StepSource(resolveStep), seed%4)
	artifacts := CompileGraph(seed)
	declGraph := ResolveSymbolGraph(SymbolGraphFromSeed(seed))
	incremental := IncrementalEntry(seed + 15)
	textBuffer := TextBufferFromSeed(seed)
	textTokens := TextStreamFromBuffer(textBuffer)
	functionTokens := TextStreamFromBuffer(FunctionTextBufferFromSeed(seed + 1))
	multiFunctionTokens := TextStreamFromBuffer(MultiFunctionTextBufferFromSeed(seed + 2))
	zeroFunctionTokens := TextStreamFromBuffer(ZeroFunctionTextBufferFromSeed(seed + 3))
	threeFunctionTokens := TextStreamFromBuffer(ThreeFunctionTextBufferFromSeed(seed + 4))
	pubFunctionTokens := TextStreamFromBuffer(PubFunctionTextBufferFromSeed(seed + 5))
	textParsed := ParseTextDeclarationStream(State(0, TextTokenStreamLength(textTokens)), textTokens, seed+1)
	textProgram := ParseTextProgram(State(0, TextTokenStreamLength(textTokens)), textTokens, seed, seed+2)
	textProgramValue := ProgramFromParseOrFallback(
		textProgram,
		ProgramOf(seed, 0, EmptyDecl(), EmptyDecl(), TextTokenStreamSpan(textTokens)),
	)
	checkedTextProgram := CheckProgram(EmptyCheckEnv(), textProgramValue, textProgramValue.Span)
	loweredTextProgram := LowerProgram(checkedTextProgram, textProgramValue.Span)
	emittedTextProgram := EmitWasmProgram(loweredTextProgram, textProgramValue.Span)
	functionProgram := ParseTextProgram(State(0, TextTokenStreamLength(functionTokens)), functionTokens, seed+1, seed+3)
	functionProgramValue := ProgramFromParseOrFallback(
		functionProgram,
		ProgramOf(seed+1, 0, EmptyDecl(), EmptyDecl(), TextTokenStreamSpan(functionTokens)),
	)
	checkedFunctionProgram := CheckProgram(EmptyCheckEnv(), functionProgramValue, functionProgramValue.Span)
	loweredFunctionProgram := LowerProgram(checkedFunctionProgram, functionProgramValue.Span)
	emittedFunctionProgram := EmitWasmProgram(loweredFunctionProgram, functionProgramValue.Span)
	multiFunctionProgram := ParseTextProgram(State(0, TextTokenStreamLength(multiFunctionTokens)), multiFunctionTokens, seed+2, seed+4)
	multiFunctionProgramValue := ProgramFromParseOrFallback(
		multiFunctionProgram,
		ProgramOf(seed+2, 0, EmptyDecl(), EmptyDecl(), TextTokenStreamSpan(multiFunctionTokens)),
	)
	checkedMultiFunctionProgram := CheckProgram(EmptyCheckEnv(), multiFunctionProgramValue, multiFunctionProgramValue.Span)
	loweredMultiFunctionProgram := LowerProgram(checkedMultiFunctionProgram, multiFunctionProgramValue.Span)
	emittedMultiFunctionProgram := EmitWasmProgram(loweredMultiFunctionProgram, multiFunctionProgramValue.Span)
	zeroFunctionProgram := ParseTextProgram(State(0, TextTokenStreamLength(zeroFunctionTokens)), zeroFunctionTokens, seed+3, seed+5)
	zeroFunctionProgramValue := ProgramFromParseOrFallback(
		zeroFunctionProgram,
		ProgramOf(seed+3, 0, EmptyDecl(), EmptyDecl(), TextTokenStreamSpan(zeroFunctionTokens)),
	)
	checkedZeroFunctionProgram := CheckProgram(EmptyCheckEnv(), zeroFunctionProgramValue, zeroFunctionProgramValue.Span)
	loweredZeroFunctionProgram := LowerProgram(checkedZeroFunctionProgram, zeroFunctionProgramValue.Span)
	emittedZeroFunctionProgram := EmitWasmProgram(loweredZeroFunctionProgram, zeroFunctionProgramValue.Span)
	threeFunctionProgram := ParseTextProgram(State(0, TextTokenStreamLength(threeFunctionTokens)), threeFunctionTokens, seed+4, seed+6)
	threeFunctionProgramValue := ProgramFromParseOrFallback(
		threeFunctionProgram,
		ProgramOf(seed+4, 0, EmptyDecl(), EmptyDecl(), TextTokenStreamSpan(threeFunctionTokens)),
	)
	checkedThreeFunctionProgram := CheckProgram(EmptyCheckEnv(), threeFunctionProgramValue, threeFunctionProgramValue.Span)
	loweredThreeFunctionProgram := LowerProgram(checkedThreeFunctionProgram, threeFunctionProgramValue.Span)
	emittedThreeFunctionProgram := EmitWasmProgram(loweredThreeFunctionProgram, threeFunctionProgramValue.Span)
	pubFunctionProgram := ParseTextProgram(State(0, TextTokenStreamLength(pubFunctionTokens)), pubFunctionTokens, seed+5, seed+7)
	pubFunctionProgramValue := ProgramFromParseOrFallback(
		pubFunctionProgram,
		ProgramOf(seed+5, 0, EmptyDecl(), EmptyDecl(), TextTokenStreamSpan(pubFunctionTokens)),
	)
	checkedPubFunctionProgram := CheckProgram(EmptyCheckEnv(), pubFunctionProgramValue, pubFunctionProgramValue.Span)
	loweredPubFunctionProgram := LowerProgram(checkedPubFunctionProgram, pubFunctionProgramValue.Span)
	emittedPubFunctionProgram := EmitWasmProgram(loweredPubFunctionProgram, pubFunctionProgramValue.Span)
	textLex := TextLexEntry(seed + 16)
	return TokenScore(first) +
		SourceScore(moduleSource) +
		GraphScore(graph) +
		ResolveStepScore(resolveStep) +
		StreamScore(source) +
		ParseResultScore(parsed) +
		ParseDiagnosticScore(parsed) +
		ExprParseResultScore(expr) +
		CheckedDeclScore(checked) +
		LoweredDeclScore(lowered) +
		WasmModuleScore(emitted) +
		WasmBinaryScore(encoded) +
		ArtifactTableScore(artifacts) +
		SymbolGraphScore(declGraph) +
		incremental +
		TextTokenStreamScore(textTokens) +
		TextTokenStreamScore(functionTokens) +
		TextTokenStreamScore(multiFunctionTokens) +
		TextTokenStreamScore(zeroFunctionTokens) +
		TextTokenStreamScore(threeFunctionTokens) +
		TextTokenStreamScore(pubFunctionTokens) +
		ParseResultScore(textParsed) +
		ParseDiagnosticScore(textParsed) +
		ProgramParseResultScore(textProgram) +
		CheckedProgramScore(checkedTextProgram) +
		LoweredProgramScore(loweredTextProgram) +
		WasmModuleScore(emittedTextProgram) +
		WasmBinaryScore(EncodeWasmBinary(emittedTextProgram)) +
		ProgramParseResultScore(functionProgram) +
		CheckedProgramScore(checkedFunctionProgram) +
		LoweredProgramScore(loweredFunctionProgram) +
		WasmModuleScore(emittedFunctionProgram) +
		WasmBinaryScore(EncodeWasmBinary(emittedFunctionProgram)) +
		ProgramParseResultScore(multiFunctionProgram) +
		CheckedProgramScore(checkedMultiFunctionProgram) +
		LoweredProgramScore(loweredMultiFunctionProgram) +
		WasmModuleScore(emittedMultiFunctionProgram) +
		WasmBinaryScore(EncodeWasmBinary(emittedMultiFunctionProgram)) +
		ProgramParseResultScore(zeroFunctionProgram) +
		CheckedProgramScore(checkedZeroFunctionProgram) +
		LoweredProgramScore(loweredZeroFunctionProgram) +
		WasmModuleScore(emittedZeroFunctionProgram) +
		WasmBinaryScore(EncodeWasmBinary(emittedZeroFunctionProgram)) +
		ProgramParseResultScore(threeFunctionProgram) +
		CheckedProgramScore(checkedThreeFunctionProgram) +
		LoweredProgramScore(loweredThreeFunctionProgram) +
		WasmModuleScore(emittedThreeFunctionProgram) +
		WasmBinaryScore(EncodeWasmBinary(emittedThreeFunctionProgram)) +
		ProgramParseResultScore(pubFunctionProgram) +
		CheckedProgramScore(checkedPubFunctionProgram) +
		LoweredProgramScore(loweredPubFunctionProgram) +
		WasmModuleScore(emittedPubFunctionProgram) +
		WasmBinaryScore(EncodeWasmBinary(emittedPubFunctionProgram)) +
		textLex +
		SpanWidth(source.SourceSpan) +
		LexResultScore(lexed)
}
