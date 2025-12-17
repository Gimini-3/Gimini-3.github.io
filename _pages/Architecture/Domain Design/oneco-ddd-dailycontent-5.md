---
title: "[ONECO DDD 도메인 설계 시리즈 Part 5] AbstractSequence와 정렬 전략"
date: 2025-12-17 15:32:00 +0900
tags:
  - DDD
  - domain-driven design
  - domain design
  - architecture
  - aggregate
  - domain model
  - entity
  - value object
thumbnail: "/assets/img/thumbnail/oneco-ddd-dailycontent.png"
---

# [ONECO DDD 도메인 설계 시리즈 Part 5] AbstractSequence와 정렬 전략

## 0. 이 글에서 다룰 것

이 글은 “하루치 학습(DailyContent)” 애그리거트에서 **순서/일차/문항 번호**를 어떻게 다뤘는지에 대한 설계 기록이다.

내가 실제로 겪은 고민은 대략 이런 거였다.

- “카테고리 안에서 N일차(DaySequence)”
- “DailyContent 안에서 1번/2번 뉴스(NewsItemOrder)”
- “DailyContent 안에서 1번/2번/3번 퀴즈(QuestionOrder)”
- 그런데 이걸 그냥 `int` 필드로만 두면:
    - 0, 음수 같은 이상한 값도 들어가고
    - DaySequence랑 QuestionOrder를 서로 섞어써도 컴파일이 안 막아주고
    - 도메인 규칙이 여기저기 흩어지는 느낌이 들었다.

그래서 나온 결론이:

> “순서를 그냥 숫자로 보지 말고, 도메인 개념으로 끌어올리자.
>
>
> 그리고 그 공통 규칙은 `AbstractSequence`라는 기반 클래스로 모으자.”
>

이 글에서는 실제 코드 기준으로,

- `AbstractSequence`가 어떤 역할을 하는지
- `DaySequence`, `NewsItemOrder`, `QuestionOrder`를 어떻게 얹었는지
- `DailyContent` 안에서 순서를 어떻게 검증/보호하는지
- JPA `@OneToMany`에서 **정렬/순서 보장 문제**를 어떻게 바라보고 있는지

를 차례대로 정리해본다.

---

## 1. 그냥 int로 해도 될까?

처음 도메인 요구는 아주 단순했다.

- 카테고리 별로 **1일차, 2일차, 3일차 …** 로 진행된다. → `DaySequence`
- 하루 콘텐츠 안에는
    - 뉴스 여러 개가 있고, **1번 뉴스, 2번 뉴스, 3번 뉴스…** 순서가 있다. → `NewsItemOrder`
    - 퀴즈도 여러 개가 있고, **1번 문제, 2번 문제, 3번 문제…** 순서가 있다. → `QuestionOrder`

처음 계획은 이거였다.

```java
int day;           // 1일차
int newsOrder;     // 뉴스 순서
int questionOrder; // 퀴즈 순서
```

근데 생각해본 결과 다음과 같은 문제가 있었다.

- 0, -1 같은 값이 들어가도 **컴파일**은 잘 된다.
- `day`를 잘못 넘겨서 `questionOrder`에 넣어도, 둘 다 `int`라서 **컴파일이 막아주지 않는다.**
- “1 이상이어야 한다” 같은 공통 규칙을 중복 구현하게 된다.
    - “1 미만이면 예외 던지자”를 여기저기서 매번 써야 함.

그리고 이 프로젝트에서 나는 “순번”이 꽤 중요한 도메인 규칙이라고 봤다.

- 1일차, 2일차의 순서가 뒤바뀌면 그 카테고리 커리큘럼이 깨짐
- 1번 뉴스와 2번 뉴스의 순서가 바뀌면 의도한 흐름이 달라짐
- 퀴즈도 1→2→3의 흐름이 의미가 있을 수 있음

그래서 결정했다.

> “순서를 그냥 숫자로 두지 말고, 값 객체로 올리자.
>
>
> 그리고 ‘1 이상이어야 한다’ 같은 공통 규칙도 한 곳에 모으자.”
>

그게 바로 `AbstractSequence`다.

---

## 2. AbstractSequence – 1부터 시작하는 순번의 공통 부모

### 2.1 코드 전체

```java
@Getter
public class AbstractSequence {

	private final int value;

	protected AbstractSequence(int value){
		if (value < 1){
			throw new IllegalArgumentException(
				this.getClass().getSimpleName() + "은(는) 1 이상의 값이어야 합니다: " + value
			);
		}
		this.value = value;
	}

	public final int value(){
		return value;
	}

	protected final int nextValue(){
		return this.value + 1;
	}

	protected String getTypeName() {
		return this.getClass().getSimpleName();
	}

	@Override
	public final boolean equals(Object o){
		if (this == o) return true;
		if (o == null || getClass() != o.getClass()) return false;

		AbstractSequence that = (AbstractSequence) o;
		return value == that.value;
	}

	@Override
	public final int hashCode(){
		return Objects.hash(this.getClass(), value);
	}

	@Override
	public String toString(){
		return getTypeName() + "(" + value + ")";
	}
}

```

### 2.2 여기서 의도했던 것들

1. **공통 규칙 한 번에**

   모든 “순번/일차” 계열에 대해

- **1 이상이어야 한다**라는 규칙을 **한 번만** 구현하고 싶었다.
- 그래서 `AbstractSequence(int value)` 생성자에서 바로 검증한다.
1. **타입 안전성**
- `getClass()` 기반으로 `equals`를 구현했다.
    - `instanceof`가 아니라 `getClass()`를 쓴 이유는,
        - `DaySequence(1)` 과 `QuestionOrder(1)` 는

          **숫자는 같아도 도메인 의미가 완전 다르기 때문**이다.

        - “둘 다 1이니까 같다고 치자”는 설계를 피하고 싶었다.
- 결과적으로
    - 같은 타입 + 같은 값 → equal
    - 다른 타입이면 값이 같아도 → not equal
1. **불변성과 일관성**
- `value`를 `private final` 로 두고,

  생성자에서 한 번 세팅하고 이후로는 바꾸지 않는다.

- `value()` / `nextValue()` 만을 통해서 읽기/증가 로직을 제공한다.
    - `nextValue()`가 `int`를 반환하는 이유는,
        - “구체 타입이 어떤 건지”는 서브클래스가 결정해야 하기 때문.
        - 예: `DaySequence.next()`는 `new DaySequence(nextValue())`를 만들도록.

---

## 3. DaySequence / NewsItemOrder / QuestionOrder – 모두 같은 숫자, 모두 다른 의미

이제 이 공통 부모 위에, 실제 도메인 타입들을 얹었다.

### 3.1 DaySequence – “카테고리 내 N일차”

```java
public class DaySequence extends AbstractSequence implements Comparable<DaySequence> {

	public DaySequence(int value) {
		super(value);
	}

	public DaySequence next(){
		return new DaySequence(nextValue());
	}

	@Override
	public int compareTo(DaySequence o){
		return Integer.compare(this.value(), o.value());
	}
}
```

- 의미: “이 카테고리에서 몇 일차인지?”
- 비즈니스 상:
    - 0일차라는 건 없다 → `AbstractSequence`에서 이미 막고 있다.
    - 1, 2, 3… 이라는 순서를 기준으로 정렬할 일이 많다 → `Comparable` 구현.

### 3.2 NewsItemOrder – “DailyContent 안에서 몇 번째 뉴스인가”

```java
public class NewsItemOrder extends AbstractSequence implements Comparable<NewsItemOrder> {

	public NewsItemOrder(int value) {
		super(value);
	}

	public NewsItemOrder next(){
		return new NewsItemOrder(nextValue());
	}

	public int compareTo(NewsItemOrder o){
		return Integer.compare(this.value(), o.value());
	}
}

```

- 의미: “오늘의 콘텐츠 안에서 1번 뉴스, 2번 뉴스…”
- 특징:
    - DaySequence와 구조는 거의 같지만,
    - 타입이 다르기 때문에 **도메인 의미가 섞이지 않는다.**
    - 잘못해서 `DaySequence`를 `NewsItemOrder` 파라미터로 넘기면 컴파일 에러가 난다.

### 3.3 QuestionOrder – “DailyContent 안에서 몇 번째 퀴즈인가”

```java
public class QuestionOrder extends AbstractSequence implements Comparable<QuestionOrder>{

	public QuestionOrder(int value) {
		super(value);
	}

	public QuestionOrder next(){
		return new QuestionOrder(nextValue());
	}

	public int compareTo(QuestionOrder o){
		return Integer.compare(this.value(), o.value());
	}
}

```

- 의미: “첫 번째 문제, 두 번째 문제, 세 번째 문제…”
- 똑같이 `AbstractSequence`를 상속하고, `Comparable`로 정렬이 가능하다.

여기까지의 요약:

> DaySequence / NewsItemOrder / QuestionOrder는 같은 숫자 계열 규칙을 공유하지만,
도메인 의미가 다르다.그래서 숫자 자체가 아니라, 타입으로 의미를 구분했다.이 덕분에 잘못된 타입을 전달하는 실수를 컴파일 타임에 줄일 수 있다.
>

---

## 4. DailyContent 안에서 순서를 어떻게 보호하고 검증하는가

`DailyContent`는 “오늘의 학습 세트”를 나타내는 애그리거트 루트다.

여기 안에서 뉴스/퀴즈 순서에 관련된 부분만 발췌해보면 대략 이런 느낌이다.

### 4.1 컬렉션과 getter – 외부 수정 막기

```java
@OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)
@JoinColumn(name = "daily_content_id", nullable = false)
private List<NewsItem> newsItems = new ArrayList<>();

@OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)
@JoinColumn(name = "daily_content_id", nullable = false)
private List<Quiz> quizzes = new ArrayList<>();

// 뉴스 아이템 목록을 불변 리스트로 반환한다.
public List<NewsItem> getNewsItems(){
	return List.copyOf(newsItems);
}

// 퀴즈 목록을 불변 리스트로 반환한다.
public List<Quiz> getQuizzes(){
	return List.copyOf(quizzes);
}

```

여기서 의도는 명확하다.

- 내부에 `ArrayList`로 데이터를 들고는 있지만,
- 외부로는 `List.copyOf(...)`를 통해 **불변 리스트**를 제공한다.
    - 외부 코드가 `getNewsItems().add(...)`를 시도하면 예외가 난다.
- 이유:
    - 순서와 중복체크 같은 **불변식(invariant)** 을 지키는 책임을
        - `DailyContent`에게만 주고 싶었기 때문이다.
    - 만약 컬렉션을 그대로 노출하면
        - 서비스 레이어, 컨트롤러, 테스트 코드 어디서나 마음대로 add/remove 할 수 있고,
        - 그러면 `DailyContent`가 정의한 규칙을 우회하게 된다.

즉, 설계 의도는:

> “NewsItem/Quiz는 DailyContent 내부 엔티티이므로,
>
>
> **루트가 허락한 도메인 메서드로만** 추가/삭제할 수 있게 만들자.”
>

### 4.2 addNewsItem – 순번 중복을 루트에서 막기

```java
public NewsItem addNewsItem(
	String title,
	NewsItemOrder order,
	WebLink link,
	ImageFile imageFile
) {
	Objects.requireNonNull(title, "title은 null일 수 없다.");
	Objects.requireNonNull(order, "order는 null일 수 없다.");
	Objects.requireNonNull(imageFile, "imageFile은 null일 수 없다.");
	Objects.requireNonNull(link, "link는 null일 수 없다.");

	validateNewsOrderDuplicate(order);

	NewsItem item = NewsItem.create(title, link, order, imageFile);
	newsItems.add(item);
	return item;
}

private void validateNewsOrderDuplicate(NewsItemOrder order) {
	if (newsItems.stream().anyMatch(n -> n.getNewsItemOrder().equals(order))) {
		throw new IllegalArgumentException("동일한 뉴스 순번이 이미 존재합니다: " + order.value());
	}
}

```

여기서 하고 싶은 말은 딱 하나다.

> “DailyContent 안에서 같은 순번의 뉴스는 두 개 있을 수 없다.”
>

그리고 그 룰을 **루트가 직접 지킨다.**

- 외부에서는 `NewsItem`을 `new` 하지 못한다.
    - 항상 `DailyContent.addNewsItem(...)` 을 통해서만 추가한다.
- 내부에서 `validateNewsOrderDuplicate` 로 순번 중복을 체크한다.
- 중복되면 바로 예외를 던져서 잘못된 상태가 저장/플러시 되기 전에 막는다.

퀴즈도 마찬가지다.

```java
public Quiz addQuiz(
	String question,
	QuestionOrder order,
	QuizOptions options,
	AnswerIndex answerIndex
) {
	Objects.requireNonNull(question, "question은 null일 수 없다.");
	Objects.requireNonNull(order, "order는 null일 수 없다.");
	Objects.requireNonNull(options, "options는 null일 수 없다.");
	Objects.requireNonNull(answerIndex, "answerIndex는 null일 수 없다.");

	validateQuizOrderDuplicate(order);

	Quiz quiz = Quiz.create(question, order, options, answerIndex);
	quizzes.add(quiz);
	return quiz;
}

private void validateQuizOrderDuplicate(QuestionOrder order) {
	if (quizzes.stream().anyMatch(q -> q.getQuestionOrder().equals(order))) {
		throw new IllegalArgumentException("동일한 퀴즈 순번이 이미 존재합니다: " + order.value());
	}
}

```

여기까지의 흐름:

- “순서를 VO로 끌어올린 것(AbstractSequence 계열)”이
- “루트에서 중복 체크를 할 때”도 자연스럽게 녹아든다.
    - `equals`가 타입+값 기준으로 구현되어 있기 때문에,
    - `QuestionOrder(1)` vs `QuestionOrder(1)` 비교가 정확하게 된다.

### 4.3 DB 레벨에서도 Unique 제약 추가

NewsItem 엔티티를 보면:

```java
@Entity
@Table(name="news",
	uniqueConstraints = {
		@UniqueConstraint(
			// 같은 날에 나오는 뉴스의 순서는 중복될 수 없다.
			name = "uk_daily_item_order",
			columnNames = {"daily_content_id", "item_order"}
		)
	})
@Getter
public class NewsItem {
    ...
}

```

Quiz도 마찬가지로, `daily_content_id + question_order` 유니크 제약을 두었다.

이 조합으로 얻고 싶은 건:

- **도메인 레벨**에서 한 번 (DailyContent.addXXX)
- **DB 레벨**에서 한 번 (UNIQUE 제약)

→ **이중 안전장치**를 두는 것.

도메인 코드가 아무리 잘 짜여 있어도,

멀티 스레드/멀티 인스턴스 환경에서 동시 요청이 날아오면

- 거의 동시에 같은 순번으로 insert하려고 할 수도 있다.
- 이때 마지막 방어선은 결국 DB idx + unique 제약이다.

그래서:

> “중복 방지는 도메인에서 1차 방어,
>
>
> DB에서 2차 방어.”
>

라는 전략으로 가져갔다.

---

## 5. JPA @OneToMany와 정렬 문제 – “순서가 보장되지 않는다”는 말의 의미

여기서 한 가지 더 짚어야 할 게 있다.

```java
@OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)
@JoinColumn(name = "daily_content_id", nullable = false)
private List<NewsItem> newsItems = new ArrayList<>();
```

이렇게만 써두면, JPA는 `List<NewsItem>`의 **순서를 보장해주지 않는다.**

- SQL 레벨에서 ORDER BY를 지정하지 않으면,
    - row가 어떤 순서로 나올지는 DB 마음이다.
    - PK 순서, insert 순서와 같을 때도 많지만, **절대 보장된 것은 아니다.**

### 5.1 옵션 1 – @OrderBy 사용 (DB 정렬에 맡기기)

```java
@OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)
@JoinColumn(name = "daily_content_id", nullable = false)
@OrderBy("newsItemOrder ASC")
private List<NewsItem> newsItems = new ArrayList<>();

```

그러면 JPA는 항상

`ORDER BY item_order ASC` 조건을 붙여서 가져온다.

장점

- JPA에서 가져오는 시점부터 **정렬된 상태**가 된다.
- 조회가 많은 경우, DB 인덱스를 잘 깔아주면 꽤 효율적이다.

단점 / 주의점

- 정렬 기준이 비교적 단순해야 한다.
    - VO의 필드 하나 정도는 쉽지만, 복잡한 도메인 규칙(예: 상태 + 날짜 + 우선순위 복합 정렬)은 잘 안 맞다.
- 일단 DB에 정렬 책임을 넘긴 것이기 때문에,
    - 추후에 정렬 기준을 바꿀 때 마이그레이션/인덱스 전략까지 함께 고민해야 한다.

### 5.2 옵션 2 – 도메인/서비스 레벨에서 수동 정렬

또 다른 방식은,

```java
public List<NewsItem> getNewsItemsSorted() {
	return newsItems.stream()
		.sorted(Comparator.comparing(n -> n.getNewsItemOrder().value()))
		.toList();
}

```

이렇게 **도메인 코드에서 직접 정렬**해주는 것이다.

장점

- 도메인 규칙을 코드로 표현하기가 더 유연하다.
    - 예: “순번은 같지만, 어떤 상태인 애들을 뒤로 보내자” 같은 규칙을 자유롭게 반영할 수 있다.
- 정렬을 테스트 코드로 쉽게 검증할 수 있다.

단점

- 호출할 때마다 정렬 비용이 든다.
    - 특히 컬렉션 크기가 커지면 O(N log N)의 비용이 계속 발생.
- 여러 곳에서 리스트를 가져갈 경우,
    - 어디는 정렬함 / 어디는 안 함 같은 **일관성 문제**가 생길 수 있다.

---

## 6. 지금 설계의 장점과, 앞으로 손보고 싶은 부분

### 6.1 장점

1. **타입 레벨에서 순서의 의미를 분리했다.**
- DaySequence, NewsItemOrder, QuestionOrder가 모두 `int`가 아니라 **각자 타입**이다.
- “숫자가 같으면 같은 것”이 아니라,
    - “타입 + 값이 같아야 같은 것”이라는 철학으로 설계했다.
1. **루트에서 순번 불변식을 책임진다.**
- 외부에서 `NewsItem` / `Quiz`를 직접 new 하지 못한다.
    - 항상 `DailyContent.addNewsItem`, `addQuiz`를 통해서만 추가된다.
- 그 과정에서
    - null 방지
    - 순번 중복 방지

      가 함께 처리된다.

1. **도메인 + DB 양쪽에서 중복을 막는다.**
- 도메인: `validateNewsOrderDuplicate`, `validateQuizOrderDuplicate`
- DB: `UNIQUE (daily_content_id, item_order)`, `UNIQUE (daily_content_id, question_order)`

이렇게 해두면

- 코드 오류로 인한 중복은 도메인 쪽에서 걸러지고,
- 극단적인 동시성 상황이 와도 DB가 마지막 방어선이 된다.

### 6.2 앞으로 보완하고 싶은 부분

1. **정렬 전략 선택**
- 현재는 아직 정렬 전략을 선택하지 않은 상태이다.
- 어느 시점에는 `@OrderBy("newsItemOrder ASC")`, `@OrderBy("questionOrder.value ASC")` 같은 정렬 전략을 선택해야 할 것 같다.
- 특히 조회 비중이 높아지고, 다양한 화면에서 이 순서를 사용하게 되면,
    - “항상 정렬된 상태로 로드된다”는 계약을 코드/DB에 명시하고 싶다.
1. **동시 수정 시나리오에 대한 더 강한 보장**
- 지금도 유니크 제약으로 최소 방어는 되어 있지만,
- 트래픽이 많다면
    - “같은 DaySequence/NewsItemOrder를 동시에 추가하려는 경우”에 대한
    - 비즈니스 에러 응답 패턴, 재시도 전략 등도 고민할 수 있다.